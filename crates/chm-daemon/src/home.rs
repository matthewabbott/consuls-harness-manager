//! The server's install folder, `~/.local/share/consuls-server/` (0700): what lasts between runs,
//! so it can be started again by hand (`consuls-server start`, over SSH from a phone) without the
//! Mac. `consuls-server uninstall` removes all of it.
//!
//! - `consuls-server`: the binary.
//! - `config.json` (0600): the push identity (VAPID key) and settings, written when installed.
//!   It may also carry `hosts` and `subscriptions`, imported once into the files below.
//! - `subscriptions.json` (0600): the phones to push to, kept up to date.
//! - `core/`: the core's own data folder (its `config.json` with the machines, labels and UI
//!   prefs; `known_hosts.json`; `ui-state.json`).

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::Context;

use crate::config::ServerConfig;
use crate::rundir::private_dir;

pub struct Home {
    path: PathBuf,
}

impl Home {
    /// `$CONSULS_SERVER_HOME`, else `~/.local/share/consuls-server`.
    pub fn default_path() -> PathBuf {
        match std::env::var_os("CONSULS_SERVER_HOME") {
            Some(dir) => PathBuf::from(dir),
            None => Path::new(&chm_core::local::home()).join(".local/share/consuls-server"),
        }
    }

    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        private_dir(&path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn config_path(&self) -> PathBuf {
        self.path.join("config.json")
    }

    pub fn subscriptions_path(&self) -> PathBuf {
        self.path.join("subscriptions.json")
    }

    pub fn core_dir(&self) -> PathBuf {
        self.path.join("core")
    }

    pub fn load_config(&self) -> anyhow::Result<ServerConfig> {
        let path = self.config_path();
        let text = std::fs::read_to_string(&path).with_context(|| format!("not installed: no {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("{} is unreadable", path.display()))
    }
}

/// Writes `bytes` to `path` whole (a temporary file renamed over it), readable by this user only.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn private_files() {
        let base = std::env::temp_dir().join(format!("chm-home-{}", std::process::id()));
        let home = Home::open(base.clone()).unwrap();
        assert!(home.load_config().unwrap_err().to_string().contains("not installed"));
        write_private(&home.config_path(), br#"{"vapid":{"privateKey":"x"}}"#).unwrap();
        assert_eq!(std::fs::metadata(home.config_path()).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(home.load_config().unwrap().vapid.private_key, "x");
        let _ = std::fs::remove_dir_all(base);
    }
}
