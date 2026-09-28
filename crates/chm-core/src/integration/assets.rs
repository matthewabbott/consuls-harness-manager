//! Uploads the hook assets to `~/.local/share/consuls/` (via SFTP), re-uploading only when
//! their content hash changes.

use std::time::Duration;

use tokio::io::AsyncWriteExt;

use crate::ssh::{SshConnection, exec};

const HOOK: &str = include_str!("../../../../remote-assets/chm-hook.sh");
const CLAUDE_SETTINGS: &str = include_str!("../../../../remote-assets/claude-settings.json");
const OMP_EXTENSION: &str = include_str!("../../../../remote-assets/omp-extension.ts");

/// Absolute paths of the deployed assets (forward slashes, also on Windows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assets {
    pub dir: String,
    pub hook: String,
    pub claude_settings: String,
    pub omp_extension: String,
    /// The POSIX shell that runs the hook: `sh` on Unix hosts, Git's `sh.exe` on Windows.
    pub sh: String,
}

impl Assets {
    pub fn at(home: &str) -> Self {
        Self::with_sh(home, "sh")
    }

    pub fn with_sh(home: &str, sh: &str) -> Self {
        let dir = format!("{}/.local/share/consuls", home.trim_end_matches('/'));
        Self {
            hook: format!("{dir}/chm-hook.sh"),
            claude_settings: format!("{dir}/claude-settings.json"),
            omp_extension: format!("{dir}/omp-extension.ts"),
            dir,
            sh: sh.to_string(),
        }
    }

    /// The command line that runs the hook. Plain `sh '…'` on Unix; on Windows both paths are
    /// double-quoted, which cmd.exe and bash both understand.
    pub fn hook_run(&self) -> String {
        if self.sh == "sh" { format!("sh {}", exec::sh_quote(&self.hook)) } else { format!("\"{}\" \"{}\"", self.sh, self.hook) }
    }
}

/// The Claude Code settings file (hooks) for these assets.
pub fn claude_settings(assets: &Assets) -> String {
    let mut v: serde_json::Value = serde_json::from_str(CLAUDE_SETTINGS).expect("valid template");
    if let Some(events) = v["hooks"].as_object_mut() {
        for groups in events.values_mut() {
            for group in groups.as_array_mut().into_iter().flatten() {
                for hook in group["hooks"].as_array_mut().into_iter().flatten() {
                    if let Some(cmd) = hook["command"].as_str() {
                        hook["command"] = cmd.replace("__RUN__", &assets.hook_run()).into();
                    }
                }
            }
        }
    }
    serde_json::to_string_pretty(&v).expect("serializable")
}

/// The omp extension for these assets.
pub fn omp_extension(assets: &Assets) -> String {
    let js = |s: &str| serde_json::to_string(s).expect("string");
    OMP_EXTENSION.replace("\"__SH__\"", &js(&assets.sh)).replace("\"__HOOK__\"", &js(&assets.hook))
}

/// FNV-1a over every asset, so any change triggers a redeploy.
pub fn version() -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in [HOOK, CLAUDE_SETTINGS, OMP_EXTENSION] {
        for b in part.bytes().chain([0u8]) {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

fn render(template: &str, assets: &Assets, tmux: &str) -> String {
    template.replace("__HOOK__", &assets.hook).replace("__TMUX__", tmux)
}

/// Files to deploy for these assets: (path, content, mode).
pub(crate) fn files(assets: &Assets, tmux: &str) -> Vec<(String, String, u32)> {
    vec![
        (assets.hook.clone(), render(HOOK, assets, tmux), 0o755),
        (assets.claude_settings.clone(), claude_settings(assets), 0o644),
        (assets.omp_extension.clone(), omp_extension(assets), 0o644),
        (format!("{}/VERSION", assets.dir), version(), 0o644),
    ]
}

/// Makes sure the current assets exist on the host and returns their paths.
pub async fn ensure(conn: &SshConnection, home: &str) -> Result<Assets, String> {
    let assets = Assets::at(home);
    let sftp = conn.open_sftp().await.map_err(|e| e.to_string())?;
    let version_path = format!("{}/VERSION", assets.dir);
    if sftp.read(version_path.clone()).await.ok().is_some_and(|v| v == version().as_bytes()) {
        let _ = sftp.close().await;
        return Ok(assets);
    }

    let tmux = exec::run(conn, "command -v tmux", Duration::from_secs(15))
        .await
        .map(|o| o.stdout_str().trim().to_string())
        .ok()
        .filter(|p| p.starts_with('/'))
        .unwrap_or_else(|| "tmux".into());

    let mut path = home.trim_end_matches('/').to_string();
    for part in [".local", "share", "consuls"] {
        path = format!("{path}/{part}");
        let _ = sftp.create_dir(path.clone()).await; // fine if it already exists
    }
    for (path, content, mode) in files(&assets, &tmux) {
        let mut file = sftp.create(path.clone()).await.map_err(|e| format!("writing {path}: {e}"))?;
        file.write_all(content.as_bytes()).await.map_err(|e| format!("writing {path}: {e}"))?;
        file.shutdown().await.map_err(|e| format!("closing {path}: {e}"))?;
        let attrs = russh_sftp::protocol::FileAttributes { permissions: Some(mode), ..Default::default() };
        let _ = sftp.set_metadata(path.clone(), attrs).await;
    }
    let _ = sftp.close().await;
    Ok(assets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendering_fills_placeholders() {
        let a = Assets::at("/home/u/");
        assert_eq!(a.hook, "/home/u/.local/share/consuls/chm-hook.sh");
        let hook = render(HOOK, &a, "/usr/bin/tmux");
        assert!(hook.contains("/usr/bin/tmux set-option -p"));
        assert!(!hook.contains("__"));
        let json: serde_json::Value = serde_json::from_str(&claude_settings(&a)).unwrap();
        let cmd = json["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        // Quoted, so a home directory with spaces still works.
        assert_eq!(cmd, "sh '/home/u/.local/share/consuls/chm-hook.sh' claude Stop");
        let omp = omp_extension(&a);
        assert!(omp.contains("const SH = \"sh\";") && omp.contains("\"/home/u/.local/share/consuls/chm-hook.sh\""));
        assert_eq!(version().len(), 16);
    }

    #[test]
    fn windows_rendering_quotes_both_paths() {
        let a = Assets::with_sh("C:/Users/Matthew Abbott", "D:/Program Files/Git/usr/bin/sh.exe");
        let json: serde_json::Value = serde_json::from_str(&claude_settings(&a)).unwrap();
        let cmd = json["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(
            cmd,
            "\"D:/Program Files/Git/usr/bin/sh.exe\" \"C:/Users/Matthew Abbott/.local/share/consuls/chm-hook.sh\" claude Stop"
        );
        assert!(omp_extension(&a).contains("const SH = \"D:/Program Files/Git/usr/bin/sh.exe\";"));
    }
}
