//! Where the daemon keeps things, and its settings (`daemon.json`, all optional).
//!
//! The data folder (`$CONSULS_DAEMON_DIR`, else `$XDG_DATA_HOME/consuls-daemon`, else
//! `~/.local/share/consuls-daemon`) holds:
//! - `config.json` and `known_hosts.json`: the core's own (the machines to watch);
//! - `daemon.json`: the settings below;
//! - `vapid.json`: the daemon's push identity (never rotated);
//! - `subscriptions.json`: the phones that asked for pushes.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DaemonConfig {
    /// Where the API listens. Keep it on 127.0.0.1: `tailscale serve` publishes it to your
    /// tailnet with HTTPS and says who's asking.
    pub listen: String,
    /// Tailscale logins allowed to use the API. Empty: this machine's owner (from
    /// `tailscale status`).
    pub owner_logins: Vec<String>,
    /// The app's address as the phone sees it; default `https://<this machine's MagicDNS name>`.
    pub public_origin: Option<String>,
    /// The `sub` of push tokens (a `mailto:` or `https:` URL); default the public origin.
    pub vapid_subject: Option<String>,
    /// How long a tracked agent may wait before its push.
    pub needs_input_secs: u64,
    pub finished_secs: u64,
    /// Extra origins allowed to change things (a dev server, say).
    pub allow_origins: Vec<String>,
    /// Tests only: plain-http push services on this machine.
    pub allow_insecure_endpoints: bool,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:8787".into(),
            owner_logins: Vec::new(),
            public_origin: None,
            vapid_subject: None,
            needs_input_secs: 60,
            finished_secs: 180,
            allow_origins: Vec::new(),
            allow_insecure_endpoints: false,
        }
    }
}

impl DaemonConfig {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(dir.join("daemon.json")) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn delays(&self) -> chm_core::notify::Delays {
        chm_core::notify::Delays { needs_input: Duration::from_secs(self.needs_input_secs), finished: Duration::from_secs(self.finished_secs) }
    }
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CONSULS_DAEMON_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.unwrap_or_else(|| PathBuf::from(".")).join("consuls-daemon")
}

/// This machine as Tailscale knows it: its short name, MagicDNS name, and owner's login.
#[derive(Debug, Clone, Default)]
pub struct Me {
    pub id: String,
    pub dns_name: String,
    pub login: Option<String>,
}

/// Asks the Tailscale CLI who this machine is.
pub async fn me() -> Option<Me> {
    let cli = chm_core::tailscale::find_cli()?;
    let out = tokio::time::timeout(Duration::from_secs(10), tokio::process::Command::new(cli).args(["status", "--json"]).output()).await.ok()?.ok()?;
    parse_me(&out.stdout)
}

fn parse_me(json: &[u8]) -> Option<Me> {
    let v: serde_json::Value = serde_json::from_slice(json).ok()?;
    let me = &v["Self"];
    let dns_name = me["DNSName"].as_str()?.trim_end_matches('.').to_string();
    let id = dns_name.split('.').next()?.to_ascii_lowercase();
    let login = me["UserID"].as_u64().and_then(|uid| v["User"][uid.to_string()]["LoginName"].as_str()).map(str::to_string);
    Some(Me { id, dns_name, login })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_who_this_machine_is() {
        let json = br#"{"Self":{"DNSName":"spark-d683.tail35393d.ts.net.","UserID":123},"User":{"123":{"LoginName":"someone@example.com"}}}"#;
        let me = parse_me(json).unwrap();
        assert_eq!((me.id.as_str(), me.dns_name.as_str(), me.login.as_deref()), ("spark-d683", "spark-d683.tail35393d.ts.net", Some("someone@example.com")));
    }

    #[test]
    fn defaults() {
        let c: DaemonConfig = serde_json::from_str(r#"{"finishedSecs": 90}"#).unwrap();
        assert_eq!((c.listen.as_str(), c.needs_input_secs, c.finished_secs), ("127.0.0.1:8787", 60, 90));
    }
}
