//! What a notifier is told when it starts (`ctl configure`). Kept in memory only: nothing about
//! it, secrets included, is written to the machine.

use std::time::Duration;

use chm_core::model::HostConfig;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::push::store::Subscription;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotifierConfig {
    /// The push identity phones subscribed with.
    pub vapid: VapidConfig,
    /// The phones (browsers) to push to.
    #[serde(default)]
    pub subscriptions: Vec<Subscription>,
    /// Other machines to watch over SSH. Normally empty: each machine's notifier watches that
    /// machine. The web app's home watches the others while the web app is the only phone UI.
    #[serde(default)]
    pub hosts: Vec<HostConfig>,
    /// This machine's name in pushes; default its tailnet name.
    #[serde(default)]
    pub self_name: Option<String>,
    #[serde(default)]
    pub delays: DelayConfig,
    /// Serve the phone's web app and API (on the web app's home only).
    #[serde(default)]
    pub web: Option<WebConfig>,
    /// Days without a check-in (the app, or `ctl renew`) before it stops by itself.
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
    /// Publish it on the tailnet with a foreground `tailscale serve` (gone when the notifier is).
    #[serde(default = "default_true")]
    pub tailscale_serve: bool,
    #[serde(default = "default_https_port")]
    pub https_port: u16,
    /// Where the API listens; default any free port on 127.0.0.1.
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

impl NotifierConfig {
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

/// A config from the push daemon's old files (`vapid.json`, `subscriptions.json`,
/// `config.json`, `daemon.json`), so its phones needn't subscribe again.
pub fn import_legacy(dir: &std::path::Path) -> anyhow::Result<NotifierConfig> {
    use anyhow::Context;
    let read = |name: &str| -> anyhow::Result<Option<serde_json::Value>> {
        match std::fs::read_to_string(dir.join(name)) {
            Ok(t) => Ok(Some(serde_json::from_str(&t).with_context(|| name.to_string())?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    };
    let vapid = read("vapid.json")?.context("no vapid.json")?;
    let private_key = vapid["privateKey"].as_str().context("vapid.json has no privateKey")?.to_string();
    let subscriptions: Vec<Subscription> = read("subscriptions.json")?.map(serde_json::from_value).transpose()?.unwrap_or_default();
    let hosts: Vec<HostConfig> = read("config.json")?.and_then(|c| c.get("hosts").cloned()).map(serde_json::from_value).transpose()?.unwrap_or_default();
    let old = read("daemon.json")?.unwrap_or_default();
    let strings = |key: &str| old[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    Ok(NotifierConfig {
        vapid: VapidConfig { private_key, subject: old["vapidSubject"].as_str().map(str::to_string) },
        subscriptions,
        hosts,
        self_name: None,
        delays: DelayConfig {
            needs_input_secs: old["needsInputSecs"].as_u64().unwrap_or(60),
            finished_secs: old["finishedSecs"].as_u64().unwrap_or(180),
        },
        web: Some(WebConfig {
            owner_logins: strings("ownerLogins"),
            public_origin: old["publicOrigin"].as_str().map(str::to_string),
            allow_origins: strings("allowOrigins"),
            tailscale_serve: true,
            https_port: 443,
            listen: None,
        }),
        lease_days: 7,
        lease_secs: None,
        allow_insecure_endpoints: false,
    })
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
        let c: NotifierConfig = serde_json::from_str(r#"{"vapid":{"privateKey":"x"}}"#).unwrap();
        assert_eq!((c.lease_days, c.delays.needs_input_secs, c.delays.finished_secs), (7, 60, 180));
        assert!(c.web.is_none() && c.hosts.is_empty() && c.subscriptions.is_empty());
        assert_eq!(c.lease(), Duration::from_secs(7 * 86_400));
        let w: WebConfig = serde_json::from_str("{}").unwrap();
        assert!(w.tailscale_serve && w.https_port == 443);
    }

    #[test]
    fn imports_the_old_daemon() {
        let dir = std::env::temp_dir().join(format!("chm-legacy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("vapid.json"), r#"{"privateKey":"abc"}"#).unwrap();
        std::fs::write(dir.join("subscriptions.json"), r#"[{"endpoint":"https://web.push.apple.com/x","keys":{"p256dh":"p","auth":"a"},"label":"iPhone","added":5,"lastOk":null}]"#).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"hosts":[{"id":"spark2","user":"consulear"}]}"#).unwrap();
        let c = import_legacy(&dir).unwrap();
        assert_eq!(c.vapid.private_key, "abc");
        assert_eq!((c.subscriptions.len(), c.hosts.len(), c.hosts[0].id.as_str()), (1, 1, "spark2"));
        assert!(c.web.as_ref().is_some_and(|w| w.tailscale_serve));
        let _ = std::fs::remove_dir_all(dir);
    }
}
