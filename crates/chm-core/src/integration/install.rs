//! Opt-in global integration: makes hand-started agent sessions report to Consuls too.
//!
//! - Claude Code: merges our hook entries into `~/.claude/settings.json` (backed up first).
//! - Codex: sets `notify` in `~/.codex/config.toml` — only if the user has no notify of
//!   their own (Codex allows just one; we never overwrite theirs).
//! - omp: drops `~/.omp/agent/hooks/post/consuls.ts`, which omp auto-discovers.
//!
//! Everything we add references `~/.local/share/consuls/chm-hook.sh`, which is how we find
//! (and remove) our entries again. The hook is a no-op outside tmux.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt;
use ts_rs::TS;

use super::assets::{self, Assets};
use crate::ssh::SshConnection;

const MARKER: &str = "/.local/share/consuls/chm-hook.sh";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolStatus {
    /// The harness isn't set up on this host (no config directory).
    Absent,
    NotInstalled,
    Installed,
    /// Can't install without clobbering the user's own setting (Codex `notify`).
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IntegrationStatus {
    pub claude: ToolStatus,
    pub codex: ToolStatus,
    pub omp: ToolStatus,
    /// Human-readable notes (what was changed, backups, caveats).
    pub notes: Vec<String>,
}

fn claude_template(assets: &Assets) -> Map<String, Value> {
    let rendered = include_str!("../../../../remote-assets/claude-settings.json").replace("__HOOK__", &assets.hook);
    let v: Value = serde_json::from_str(&rendered).expect("valid template");
    v["hooks"].as_object().cloned().unwrap_or_default()
}

fn is_ours(group: &Value) -> bool {
    group["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(MARKER))))
}

/// Adds our hook groups to a Claude settings object; returns true if anything changed.
pub fn claude_install(settings: &mut Value, assets: &Assets) -> bool {
    if !settings.is_object() {
        *settings = Value::Object(Map::new());
    }
    let hooks = settings.as_object_mut().unwrap().entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks.as_object_mut().unwrap();
    let mut changed = false;
    for (event, groups) in claude_template(assets) {
        let list = hooks.entry(event).or_insert_with(|| Value::Array(vec![]));
        if !list.is_array() {
            continue; // unexpected shape: leave the user's config alone
        }
        let list = list.as_array_mut().unwrap();
        if list.iter().any(is_ours) {
            continue;
        }
        list.extend(groups.as_array().cloned().unwrap_or_default());
        changed = true;
    }
    changed
}

pub fn claude_uninstall(settings: &mut Value) -> bool {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else { return false };
    let mut changed = false;
    for list in hooks.values_mut() {
        if let Some(arr) = list.as_array_mut() {
            let before = arr.len();
            arr.retain(|g| !is_ours(g));
            changed |= arr.len() != before;
        }
    }
    hooks.retain(|_, v| !v.as_array().is_some_and(|a| a.is_empty()));
    if hooks.is_empty() {
        settings.as_object_mut().unwrap().remove("hooks");
    }
    changed
}

pub fn claude_installed(settings: &Value) -> bool {
    settings["hooks"]["Stop"].as_array().is_some_and(|a| a.iter().any(is_ours))
}

pub enum CodexEdit {
    Changed(String),
    Unchanged,
    Conflict,
}

pub fn codex_install(toml: &str, assets: &Assets) -> Result<CodexEdit, String> {
    let mut doc: toml_edit::DocumentMut = toml.parse().map_err(|e| format!("config.toml: {e}"))?;
    if let Some(existing) = doc.get("notify") {
        return Ok(if existing.to_string().contains(MARKER) { CodexEdit::Unchanged } else { CodexEdit::Conflict });
    }
    let mut arr = toml_edit::Array::new();
    for part in ["sh", assets.hook.as_str(), "codex", "Stop"] {
        arr.push(part);
    }
    doc.insert("notify", toml_edit::value(arr));
    Ok(CodexEdit::Changed(doc.to_string()))
}

pub fn codex_uninstall(toml: &str) -> Result<Option<String>, String> {
    let mut doc: toml_edit::DocumentMut = toml.parse().map_err(|e| format!("config.toml: {e}"))?;
    match doc.get("notify") {
        Some(n) if n.to_string().contains(MARKER) => {
            doc.remove("notify");
            Ok(Some(doc.to_string()))
        }
        _ => Ok(None),
    }
}

pub fn codex_status(toml: &str) -> ToolStatus {
    match toml.parse::<toml_edit::DocumentMut>().ok().and_then(|d| d.get("notify").map(|n| n.to_string())) {
        Some(n) if n.contains(MARKER) => ToolStatus::Installed,
        Some(_) => ToolStatus::Conflict,
        None => ToolStatus::NotInstalled,
    }
}

// ---------------------------------------------------------------------------- remote side

struct Paths {
    claude_dir: String,
    claude_settings: String,
    codex_dir: String,
    codex_config: String,
    omp_dir: String,
    omp_hook: String,
}

fn paths(home: &str) -> Paths {
    let h = home.trim_end_matches('/');
    Paths {
        claude_dir: format!("{h}/.claude"),
        claude_settings: format!("{h}/.claude/settings.json"),
        codex_dir: format!("{h}/.codex"),
        codex_config: format!("{h}/.codex/config.toml"),
        omp_dir: format!("{h}/.omp/agent"),
        omp_hook: format!("{h}/.omp/agent/hooks/post/consuls.ts"),
    }
}

async fn read_text(sftp: &russh_sftp::client::SftpSession, path: &str) -> Option<String> {
    sftp.read(path.to_string()).await.ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

async fn write_text(sftp: &russh_sftp::client::SftpSession, path: &str, text: &str) -> Result<(), String> {
    let mut f = sftp.create(path.to_string()).await.map_err(|e| format!("{path}: {e}"))?;
    f.write_all(text.as_bytes()).await.map_err(|e| format!("{path}: {e}"))?;
    f.shutdown().await.map_err(|e| format!("{path}: {e}"))
}

async fn backup(sftp: &russh_sftp::client::SftpSession, path: &str, text: &str) -> Result<String, String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let bak = format!("{path}.chm-bak-{ts}");
    write_text(sftp, &bak, text).await?;
    Ok(bak)
}

async fn exists(sftp: &russh_sftp::client::SftpSession, path: &str) -> bool {
    sftp.try_exists(path.to_string()).await.unwrap_or(false)
}

pub async fn status(conn: &SshConnection, home: &str) -> Result<IntegrationStatus, String> {
    let p = paths(home);
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let claude = if !exists(&sftp, &p.claude_dir).await {
        ToolStatus::Absent
    } else {
        let settings: Value = read_text(&sftp, &p.claude_settings).await.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if claude_installed(&settings) { ToolStatus::Installed } else { ToolStatus::NotInstalled }
    };
    let codex = if !exists(&sftp, &p.codex_dir).await {
        ToolStatus::Absent
    } else {
        codex_status(&read_text(&sftp, &p.codex_config).await.unwrap_or_default())
    };
    let omp = if !exists(&sftp, &p.omp_dir).await {
        ToolStatus::Absent
    } else if exists(&sftp, &p.omp_hook).await {
        ToolStatus::Installed
    } else {
        ToolStatus::NotInstalled
    };
    let _ = sftp.close().await;
    Ok(IntegrationStatus { claude, codex, omp, notes: Vec::new() })
}

pub async fn install(conn: &SshConnection, home: &str) -> Result<IntegrationStatus, String> {
    let assets = assets::ensure(conn, home).await?;
    let p = paths(home);
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let mut notes = Vec::new();

    if exists(&sftp, &p.claude_dir).await {
        let original = read_text(&sftp, &p.claude_settings).await;
        let mut settings: Value = match &original {
            Some(t) => serde_json::from_str(t).map_err(|e| format!("~/.claude/settings.json isn't valid JSON ({e}); not touching it"))?,
            None => Value::Object(Map::new()),
        };
        if claude_install(&mut settings, &assets) {
            if let Some(t) = &original {
                notes.push(format!("Backed up Claude settings to {}", backup(&sftp, &p.claude_settings, t).await?));
            }
            write_text(&sftp, &p.claude_settings, &(serde_json::to_string_pretty(&settings).unwrap() + "\n")).await?;
            notes.push("Claude Code: hooks added. Sessions already running pick them up after a restart.".into());
        }
    }

    if exists(&sftp, &p.codex_dir).await {
        let original = read_text(&sftp, &p.codex_config).await.unwrap_or_default();
        match codex_install(&original, &assets)? {
            CodexEdit::Changed(new) => {
                if !original.is_empty() {
                    notes.push(format!("Backed up Codex config to {}", backup(&sftp, &p.codex_config, &original).await?));
                }
                write_text(&sftp, &p.codex_config, &new).await?;
                notes.push("Codex: turn-complete notifications enabled.".into());
            }
            CodexEdit::Conflict => notes.push(
                "Codex already has a `notify` program; left it alone. Hand-started Codex sessions fall back to output heuristics.".into(),
            ),
            CodexEdit::Unchanged => {}
        }
    }

    if exists(&sftp, &p.omp_dir).await && !exists(&sftp, &p.omp_hook).await {
        let _ = sftp.create_dir(format!("{}/hooks", p.omp_dir)).await;
        let _ = sftp.create_dir(format!("{}/hooks/post", p.omp_dir)).await;
        let ext = include_str!("../../../../remote-assets/omp-extension.ts").replace("__HOOK__", &assets.hook);
        write_text(&sftp, &p.omp_hook, &ext).await?;
        notes.push("omp: extension installed (new omp sessions load it automatically).".into());
    }
    let _ = sftp.close().await;

    let mut st = status(conn, home).await?;
    st.notes = notes;
    Ok(st)
}

pub async fn uninstall(conn: &SshConnection, home: &str) -> Result<IntegrationStatus, String> {
    let p = paths(home);
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let mut notes = Vec::new();
    if let Some(original) = read_text(&sftp, &p.claude_settings).await
        && let Ok(mut settings) = serde_json::from_str::<Value>(&original)
        && claude_uninstall(&mut settings)
    {
        backup(&sftp, &p.claude_settings, &original).await?;
        write_text(&sftp, &p.claude_settings, &(serde_json::to_string_pretty(&settings).unwrap() + "\n")).await?;
        notes.push("Claude Code: hooks removed.".into());
    }
    if let Some(original) = read_text(&sftp, &p.codex_config).await
        && let Some(new) = codex_uninstall(&original)?
    {
        backup(&sftp, &p.codex_config, &original).await?;
        write_text(&sftp, &p.codex_config, &new).await?;
        notes.push("Codex: notify removed.".into());
    }
    if exists(&sftp, &p.omp_hook).await {
        sftp.remove_file(p.omp_hook.clone()).await.map_err(|e| e.to_string())?;
        notes.push("omp: extension removed.".into());
    }
    let _ = sftp.close().await;
    let mut st = status(conn, home).await?;
    st.notes = notes;
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assets() -> Assets {
        Assets::at("/home/u")
    }

    #[test]
    fn claude_install_is_idempotent_and_reversible() {
        let original: Value = serde_json::json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }] }
        });
        let mut s = original.clone();
        assert!(claude_install(&mut s, &assets()));
        assert!(claude_installed(&s));
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 2, "user's own Stop hook kept");
        assert_eq!(s["model"], "opus");
        let once = s.clone();
        assert!(!claude_install(&mut s, &assets()), "second install changes nothing");
        assert_eq!(s, once);
        assert!(claude_uninstall(&mut s));
        assert_eq!(s, original, "uninstall restores the original");
    }

    #[test]
    fn claude_install_into_empty_settings() {
        let mut s = serde_json::json!({ "theme": "dark" });
        assert!(claude_install(&mut s, &assets()));
        assert!(claude_uninstall(&mut s));
        assert_eq!(s, serde_json::json!({ "theme": "dark" }));
    }

    #[test]
    fn codex_notify_respects_existing() {
        let cfg = "model = \"gpt-5.6-sol\" # favourite\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n";
        let CodexEdit::Changed(new) = codex_install(cfg, &assets()).unwrap() else { panic!() };
        assert!(new.contains("# favourite"), "comments preserved");
        assert!(new.find("notify").unwrap() < new.find("[projects").unwrap(), "notify stays top-level");
        assert_eq!(codex_status(&new), ToolStatus::Installed);
        assert!(matches!(codex_install(&new, &assets()).unwrap(), CodexEdit::Unchanged));
        assert_eq!(codex_uninstall(&new).unwrap().unwrap(), cfg);

        let theirs = "notify = [\"notify-send\", \"codex\"]\n";
        assert!(matches!(codex_install(theirs, &assets()).unwrap(), CodexEdit::Conflict));
        assert_eq!(codex_status(theirs), ToolStatus::Conflict);
        assert_eq!(codex_uninstall(theirs).unwrap(), None);
    }
}
