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
    let v: Value = serde_json::from_str(&super::assets::claude_settings(assets)).expect("valid template");
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
    for part in [assets.sh.as_str(), assets.hook.as_str(), "codex", "Stop"] {
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

// ---------------------------------------------------------------------------- files

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

/// The few file operations the installer needs: over SFTP on a remote host, `std::fs` on
/// this PC.
trait ConfigFiles {
    async fn read_text(&self, path: &str) -> Option<String>;
    async fn write_text(&self, path: &str, text: &str) -> Result<(), String>;
    async fn exists(&self, path: &str) -> bool;
    /// Creates a folder (fine if it's already there).
    async fn mkdir(&self, path: &str);
    async fn remove(&self, path: &str) -> Result<(), String>;
}

struct Sftp<'a>(&'a russh_sftp::client::SftpSession);

impl ConfigFiles for Sftp<'_> {
    async fn read_text(&self, path: &str) -> Option<String> {
        self.0.read(path.to_string()).await.ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    async fn write_text(&self, path: &str, text: &str) -> Result<(), String> {
        let mut f = self.0.create(path.to_string()).await.map_err(|e| format!("{path}: {e}"))?;
        f.write_all(text.as_bytes()).await.map_err(|e| format!("{path}: {e}"))?;
        f.shutdown().await.map_err(|e| format!("{path}: {e}"))
    }
    async fn exists(&self, path: &str) -> bool {
        self.0.try_exists(path.to_string()).await.unwrap_or(false)
    }
    async fn mkdir(&self, path: &str) {
        let _ = self.0.create_dir(path.to_string()).await;
    }
    async fn remove(&self, path: &str) -> Result<(), String> {
        self.0.remove_file(path.to_string()).await.map_err(|e| format!("{path}: {e}"))
    }
}

/// This PC's files (paths with forward slashes, which Windows accepts too).
struct LocalFiles;

impl ConfigFiles for LocalFiles {
    async fn read_text(&self, path: &str) -> Option<String> {
        std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    async fn write_text(&self, path: &str, text: &str) -> Result<(), String> {
        std::fs::write(path, text).map_err(|e| format!("{path}: {e}"))
    }
    async fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }
    async fn mkdir(&self, path: &str) {
        let _ = std::fs::create_dir(path);
    }
    async fn remove(&self, path: &str) -> Result<(), String> {
        std::fs::remove_file(path).map_err(|e| format!("{path}: {e}"))
    }
}

async fn backup(f: &impl ConfigFiles, path: &str, text: &str) -> Result<String, String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let bak = format!("{path}.chm-bak-{ts}");
    f.write_text(&bak, text).await?;
    Ok(bak)
}

async fn status_in(f: &impl ConfigFiles, home: &str) -> IntegrationStatus {
    let p = paths(home);
    let claude = if !f.exists(&p.claude_dir).await {
        ToolStatus::Absent
    } else {
        let settings: Value = f.read_text(&p.claude_settings).await.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if claude_installed(&settings) { ToolStatus::Installed } else { ToolStatus::NotInstalled }
    };
    let codex = if !f.exists(&p.codex_dir).await {
        ToolStatus::Absent
    } else {
        codex_status(&f.read_text(&p.codex_config).await.unwrap_or_default())
    };
    let omp = if !f.exists(&p.omp_dir).await {
        ToolStatus::Absent
    } else if f.exists(&p.omp_hook).await {
        ToolStatus::Installed
    } else {
        ToolStatus::NotInstalled
    };
    IntegrationStatus { claude, codex, omp, notes: Vec::new() }
}

/// Adds our hooks wherever a harness is set up; returns notes on what changed.
async fn install_in(f: &impl ConfigFiles, home: &str, assets: &Assets) -> Result<Vec<String>, String> {
    let p = paths(home);
    let mut notes = Vec::new();

    if f.exists(&p.claude_dir).await {
        let original = f.read_text(&p.claude_settings).await;
        let mut settings: Value = match &original {
            Some(t) => serde_json::from_str(t).map_err(|e| format!("~/.claude/settings.json isn't valid JSON ({e}); not touching it"))?,
            None => Value::Object(Map::new()),
        };
        if claude_install(&mut settings, assets) {
            if let Some(t) = &original {
                notes.push(format!("Backed up Claude settings to {}", backup(f, &p.claude_settings, t).await?));
            }
            f.write_text(&p.claude_settings, &(serde_json::to_string_pretty(&settings).unwrap() + "\n")).await?;
            notes.push("Claude Code: hooks added. Sessions already running pick them up after a restart.".into());
        }
    }

    if f.exists(&p.codex_dir).await {
        let original = f.read_text(&p.codex_config).await.unwrap_or_default();
        match codex_install(&original, assets)? {
            CodexEdit::Changed(new) => {
                if !original.is_empty() {
                    notes.push(format!("Backed up Codex config to {}", backup(f, &p.codex_config, &original).await?));
                }
                f.write_text(&p.codex_config, &new).await?;
                notes.push("Codex: turn-complete notifications enabled.".into());
            }
            CodexEdit::Conflict => notes.push(
                "Codex already has a `notify` program; left it alone. Hand-started Codex sessions fall back to output heuristics.".into(),
            ),
            CodexEdit::Unchanged => {}
        }
    }

    if f.exists(&p.omp_dir).await && !f.exists(&p.omp_hook).await {
        f.mkdir(&format!("{}/hooks", p.omp_dir)).await;
        f.mkdir(&format!("{}/hooks/post", p.omp_dir)).await;
        f.write_text(&p.omp_hook, &super::assets::omp_extension(assets)).await?;
        notes.push("omp: extension installed (new omp sessions load it automatically).".into());
    }
    Ok(notes)
}

/// Removes everything `install_in` added (backing up edited files); returns notes.
async fn uninstall_in(f: &impl ConfigFiles, home: &str) -> Result<Vec<String>, String> {
    let p = paths(home);
    let mut notes = Vec::new();
    if let Some(original) = f.read_text(&p.claude_settings).await
        && let Ok(mut settings) = serde_json::from_str::<Value>(&original)
        && claude_uninstall(&mut settings)
    {
        backup(f, &p.claude_settings, &original).await?;
        f.write_text(&p.claude_settings, &(serde_json::to_string_pretty(&settings).unwrap() + "\n")).await?;
        notes.push("Claude Code: hooks removed.".into());
    }
    if let Some(original) = f.read_text(&p.codex_config).await
        && let Some(new) = codex_uninstall(&original)?
    {
        backup(f, &p.codex_config, &original).await?;
        f.write_text(&p.codex_config, &new).await?;
        notes.push("Codex: notify removed.".into());
    }
    if f.exists(&p.omp_hook).await {
        f.remove(&p.omp_hook).await?;
        notes.push("omp: extension removed.".into());
    }
    Ok(notes)
}

// ---------------------------------------------------------------------------- remote hosts

pub async fn status(conn: &SshConnection, home: &str) -> Result<IntegrationStatus, String> {
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let st = status_in(&Sftp(&sftp), home).await;
    let _ = sftp.close().await;
    Ok(st)
}

pub async fn install(conn: &SshConnection, home: &str, tmux: Option<&str>) -> Result<IntegrationStatus, String> {
    let assets = assets::ensure(conn, home, tmux).await?;
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let result = install_in(&Sftp(&sftp), home, &assets).await;
    let st = status_in(&Sftp(&sftp), home).await;
    let _ = sftp.close().await;
    Ok(IntegrationStatus { notes: result?, ..st })
}

pub async fn uninstall(conn: &SshConnection, home: &str) -> Result<IntegrationStatus, String> {
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let result = uninstall_in(&Sftp(&sftp), home).await;
    let st = status_in(&Sftp(&sftp), home).await;
    let _ = sftp.close().await;
    Ok(IntegrationStatus { notes: result?, ..st })
}

// ---------------------------------------------------------------------------- this PC

pub async fn local_status(home: &str) -> IntegrationStatus {
    status_in(&LocalFiles, home).await
}

/// `assets` are this PC's hook assets (`local::ensure_assets`), with Git's `sh.exe` on Windows.
pub async fn local_install(home: &str, assets: &Assets) -> Result<IntegrationStatus, String> {
    let notes = install_in(&LocalFiles, home, assets).await?;
    Ok(IntegrationStatus { notes, ..status_in(&LocalFiles, home).await })
}

pub async fn local_uninstall(home: &str) -> Result<IntegrationStatus, String> {
    let notes = uninstall_in(&LocalFiles, home).await?;
    Ok(IntegrationStatus { notes, ..status_in(&LocalFiles, home).await })
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

    /// This PC's install, on a scratch home (never the real `~/.claude` etc.).
    #[tokio::test]
    async fn local_install_round_trip() {
        use ToolStatus::*;
        let home = std::env::temp_dir().join(format!("chm-install-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for d in [".claude", ".codex", ".omp/agent"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        let settings = "{ \"theme\": \"dark\" }";
        let codex = "model = \"gpt-5.6-sol\"\n";
        std::fs::write(home.join(".claude/settings.json"), settings).unwrap();
        std::fs::write(home.join(".codex/config.toml"), codex).unwrap();
        let h = crate::local::to_slash(&home);
        let assets = Assets::with_sh(&h, "D:/Program Files/Git/usr/bin/sh.exe");
        let tools = |st: &IntegrationStatus| (st.claude, st.codex, st.omp);

        assert_eq!(tools(&local_status(&h).await), (NotInstalled, NotInstalled, NotInstalled));
        let st = local_install(&h, &assets).await.unwrap();
        assert_eq!(tools(&st), (Installed, Installed, Installed));
        assert_eq!(st.notes.iter().filter(|n| n.starts_with("Backed up")).count(), 2, "{:?}", st.notes);
        let written = std::fs::read_to_string(home.join(".claude/settings.json")).unwrap();
        assert!(written.contains("\\\"D:/Program Files/Git/usr/bin/sh.exe\\\""), "hooks run through Git's sh: {written}");
        assert!(std::fs::read_to_string(home.join(".omp/agent/hooks/post/consuls.ts")).unwrap().contains("chm-hook.sh"));
        assert!(local_install(&h, &assets).await.unwrap().notes.is_empty(), "installing again changes nothing");

        let st = local_uninstall(&h).await.unwrap();
        assert_eq!(tools(&st), (NotInstalled, NotInstalled, NotInstalled));
        let back: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude/settings.json")).unwrap()).unwrap();
        assert_eq!(back, serde_json::from_str::<Value>(settings).unwrap());
        assert_eq!(std::fs::read_to_string(home.join(".codex/config.toml")).unwrap(), codex);

        // A harness that isn't set up is left alone.
        std::fs::remove_dir_all(home.join(".omp")).unwrap();
        assert_eq!(local_install(&h, &assets).await.unwrap().omp, Absent);
        assert!(!home.join(".omp").exists());
        let _ = std::fs::remove_dir_all(&home);
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
