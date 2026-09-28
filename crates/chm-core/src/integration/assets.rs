//! Uploads the hook assets to `~/.local/share/consuls/` (via SFTP), re-uploading only when
//! their content hash changes.

use std::time::Duration;

use tokio::io::AsyncWriteExt;

use crate::ssh::{SshConnection, exec};

const HOOK: &str = include_str!("../../../../remote-assets/chm-hook.sh");
const CLAUDE_SETTINGS: &str = include_str!("../../../../remote-assets/claude-settings.json");
const OMP_EXTENSION: &str = include_str!("../../../../remote-assets/omp-extension.ts");

/// Absolute remote paths of the deployed assets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assets {
    pub dir: String,
    pub hook: String,
    pub claude_settings: String,
    pub omp_extension: String,
}

impl Assets {
    pub fn at(home: &str) -> Self {
        let dir = format!("{}/.local/share/consuls", home.trim_end_matches('/'));
        Self {
            hook: format!("{dir}/chm-hook.sh"),
            claude_settings: format!("{dir}/claude-settings.json"),
            omp_extension: format!("{dir}/omp-extension.ts"),
            dir,
        }
    }
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
    let files = [
        (&assets.hook, render(HOOK, &assets, &tmux), 0o755),
        (&assets.claude_settings, render(CLAUDE_SETTINGS, &assets, &tmux), 0o644),
        (&assets.omp_extension, render(OMP_EXTENSION, &assets, &tmux), 0o644),
        (&version_path, version(), 0o644),
    ];
    for (path, content, mode) in files {
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
        let claude = render(CLAUDE_SETTINGS, &a, "tmux");
        let json: serde_json::Value = serde_json::from_str(&claude).unwrap();
        let cmd = json["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(cmd, "sh /home/u/.local/share/consuls/chm-hook.sh claude Stop");
        assert!(render(OMP_EXTENSION, &a, "tmux").contains("\"/home/u/.local/share/consuls/chm-hook.sh\""));
        assert_eq!(version().len(), 16);
    }
}
