//! The server's settings and push identity: `config.json` in its install folder (`home.rs`),
//! written when it's installed (from the copy kept on the Mac).

use std::time::Duration;

use chm_core::model::HostConfig;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::push::store::Subscription;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerConfig {
    /// The push identity phones subscribed with.
    pub vapid: VapidConfig,
    /// Seed: the phones to push to, imported into `subscriptions.json` when that's missing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subscriptions: Vec<Subscription>,
    /// Seed: the machines to watch over SSH, imported into the core's own config when that's
    /// missing (from then on they're edited from the app).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<HostConfig>,
    /// This machine's name in pushes; default its tailnet name.
    #[serde(default)]
    pub self_name: Option<String>,
    #[serde(default)]
    pub delays: DelayConfig,
    /// Serve the phone's web app and API.
    #[serde(default)]
    pub web: Option<WebConfig>,
    /// Days without a check-in (using the web app, or `ctl renew`) before it stops by itself (its
    /// files stay: `consuls-server start` brings it back).
    #[serde(default = "default_lease_days")]
    #[ts(type = "number")]
    pub lease_days: u64,
    /// Tests: a lease in seconds instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub lease_secs: Option<u64>,
    /// Tests: plain-http push services on this machine.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(skip)]
    pub allow_insecure_endpoints: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VapidConfig {
    /// The P-256 private scalar, base64url.
    pub private_key: String,
    /// The `sub` of push tokens (`mailto:` or `https:`); default the web app's address.
    #[serde(default)]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct DelayConfig {
    /// How long a tracked agent may wait for input before its push.
    #[ts(type = "number")]
    pub needs_input_secs: u64,
    /// How long after finishing its turn.
    #[ts(type = "number")]
    pub finished_secs: u64,
}

impl Default for DelayConfig {
    fn default() -> Self {
        Self { needs_input_secs: 60, finished_secs: 180 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WebConfig {
    /// Tailscale logins allowed in; empty: this machine's owner.
    #[serde(default)]
    pub owner_logins: Vec<String>,
    /// The web app's address as the phone sees it; default `https://<this machine's MagicDNS name>`.
    #[serde(default)]
    pub public_origin: Option<String>,
    /// Extra origins allowed to change things (a dev server).
    #[serde(default)]
    pub allow_origins: Vec<String>,
    /// Publish it on the tailnet with a foreground `tailscale serve` (gone when the server is).
    #[serde(default = "default_true")]
    pub tailscale_serve: bool,
    #[serde(default = "default_https_port")]
    pub https_port: u16,
    /// A TCP address for the API (tests, development); default a unix socket in the run folder,
    /// which only this user and `tailscale serve` can reach.
    #[serde(default)]
    pub listen: Option<String>,
}

fn default_lease_days() -> u64 {
    7
}

fn default_true() -> bool {
    true
}

fn default_https_port() -> u16 {
    443
}

impl ServerConfig {
    pub fn delays(&self) -> chm_core::notify::Delays {
        chm_core::notify::Delays { needs_input: Duration::from_secs(self.delays.needs_input_secs), finished: Duration::from_secs(self.delays.finished_secs) }
    }

    pub fn lease(&self) -> Duration {
        self.lease_secs.map(Duration::from_secs).unwrap_or(Duration::from_secs(self.lease_days.max(1) * 86_400))
    }
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
        let c: ServerConfig = serde_json::from_str(r#"{"vapid":{"privateKey":"x"}}"#).unwrap();
        assert_eq!((c.lease_days, c.delays.needs_input_secs, c.delays.finished_secs), (7, 60, 180));
        assert!(c.web.is_none() && c.hosts.is_empty() && c.subscriptions.is_empty());
        assert_eq!(c.lease(), Duration::from_secs(7 * 86_400));
        let w: WebConfig = serde_json::from_str("{}").unwrap();
        assert!(w.tailscale_serve && w.https_port == 443);
    }
}
