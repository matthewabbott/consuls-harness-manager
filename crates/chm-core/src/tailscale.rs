//! Reads tailnet state from the local Tailscale CLI (`tailscale status --json`), or, where
//! there's none (the iPhone), from a connected machine's ([`STATUS_SCRIPT`], [`parse_remote`]).

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;

use crate::model::{TailnetPeer, TailnetStatus};

/// Locates the Tailscale CLI. It is usually not on PATH on Windows or macOS.
pub fn find_cli() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(dir) = std::env::var(var) {
                candidates.push(PathBuf::from(dir).join("Tailscale").join("tailscale.exe"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/tailscale"));
        candidates.push(PathBuf::from("/usr/local/bin/tailscale"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push(PathBuf::from("/usr/bin/tailscale"));
        candidates.push(PathBuf::from("/usr/local/bin/tailscale"));
    }
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    let exe = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(exe))
            .find(|p| p.is_file())
    })
}

/// Runs `tailscale status --json` without flashing a console window.
pub async fn fetch_status() -> TailnetStatus {
    let Some(cli) = find_cli() else {
        return TailnetStatus {
            error: Some("Tailscale CLI not found. Is Tailscale installed?".into()),
            ..Default::default()
        };
    };
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.args(["status", "--json"]).kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return TailnetStatus {
                error: Some(format!("Failed to run {}: {e}", cli.display())),
                ..Default::default()
            };
        }
        Err(_) => {
            return TailnetStatus {
                error: Some("`tailscale status` timed out".into()),
                ..Default::default()
            };
        }
    };
    // `tailscale status --json` still prints JSON (with BackendState) when logged out,
    // but may exit non-zero; only treat it as an error if the JSON doesn't parse.
    match parse_status(&output.stdout) {
        Ok(status) => status,
        Err(e) => TailnetStatus {
            error: Some(format!(
                "Couldn't parse tailscale status ({e}): {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            ..Default::default()
        },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawStatus {
    #[serde(default)]
    backend_state: String,
    #[serde(rename = "AuthURL", default)]
    auth_url: String,
    #[serde(rename = "Self")]
    self_node: Option<RawPeer>,
    #[serde(default)]
    peer: Option<BTreeMap<String, RawPeer>>,
    current_tailnet: Option<RawTailnet>,
    #[serde(default)]
    health: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTailnet {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPeer {
    #[serde(default)]
    host_name: String,
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "OS", default)]
    os: String,
    #[serde(rename = "TailscaleIPs", default)]
    tailscale_ips: Option<Vec<String>>,
    #[serde(default)]
    online: bool,
    #[serde(rename = "sshHostKeys", default)]
    ssh_host_keys: Option<Vec<String>>,
}

fn short_name(dns_name: &str, host_name: &str) -> String {
    let label = dns_name.split('.').next().unwrap_or_default();
    if label.is_empty() { host_name.to_lowercase() } else { label.to_lowercase() }
}

fn convert(raw: RawPeer, is_self: bool) -> TailnetPeer {
    TailnetPeer {
        id: short_name(&raw.dns_name, &raw.host_name),
        dns_name: raw.dns_name.trim_end_matches('.').to_string(),
        host_name: raw.host_name,
        os: raw.os,
        ips: raw.tailscale_ips.unwrap_or_default(),
        online: raw.online,
        ssh_host_keys: raw.ssh_host_keys.unwrap_or_default(),
        is_self,
    }
}

/// Run on a machine over SSH: the address we came from, then its `tailscale status --json`.
/// Login shells don't always have the CLI on PATH, so the usual places are tried too.
pub const STATUS_SCRIPT: &str = r#"echo "chm-client ${SSH_CLIENT%% *}"
for t in tailscale /usr/bin/tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$t" >/dev/null 2>&1; then exec "$t" status --json; fi
done
echo "no Tailscale CLI on this machine" >&2
exit 127
"#;

/// The tailnet as `via` sees it ([`STATUS_SCRIPT`]'s output), turned around: `via` becomes a
/// peer, and the peer we connected from (found by its address) becomes this device.
pub fn parse_remote(output: &[u8], via: &str) -> Result<TailnetStatus, String> {
    let text = String::from_utf8_lossy(output);
    // Whatever a login shell prints first is skipped.
    let (_, rest) = text.split_once("chm-client").ok_or("no answer from the status script")?;
    let (client, json) = rest.split_once('\n').unwrap_or((rest, ""));
    let client = client.trim();
    let mut status = parse_status(json.as_bytes()).map_err(|e| format!("couldn't read {via}'s tailscale status: {e}"))?;
    if let Some(mut there) = status.self_node.take() {
        there.is_self = false;
        status.peers.push(there);
    }
    if !client.is_empty()
        && let Some(i) = status.peers.iter().position(|p| p.ips.iter().any(|ip| ip == client))
    {
        let mut me = status.peers.remove(i);
        me.is_self = true;
        status.self_node = Some(me);
    }
    status.peers.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.id.cmp(&b.id)));
    status.via = Some(via.to_string());
    Ok(status)
}

pub fn parse_status(json: &[u8]) -> Result<TailnetStatus, serde_json::Error> {
    let raw: RawStatus = serde_json::from_slice(json)?;
    let mut peers: Vec<TailnetPeer> = raw
        .peer
        .unwrap_or_default()
        .into_values()
        .map(|p| convert(p, false))
        .collect();
    peers.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.id.cmp(&b.id)));
    Ok(TailnetStatus {
        backend_state: raw.backend_state,
        auth_url: Some(raw.auth_url).filter(|u| !u.is_empty()),
        self_node: raw.self_node.map(|p| convert(p, true)),
        peers,
        tailnet_name: raw.current_tailnet.map(|t| t.name).filter(|n| !n.is_empty()),
        health: raw.health.unwrap_or_default(),
        error: None,
        via: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "Version": "1.102.4",
      "BackendState": "Running",
      "AuthURL": "",
      "Self": {"HostName": "DESKTOP-J0PIMAK", "DNSName": "desktop-j0pimak.tail123.ts.net.", "OS": "windows",
               "TailscaleIPs": ["100.126.81.48", "fd7a:115c:a1e0::1"], "Online": true},
      "Peer": {
        "nodekey:aaa": {"HostName": "spark2", "DNSName": "spark2.tail123.ts.net.", "OS": "linux",
          "TailscaleIPs": ["fd7a:115c:a1e0::2", "100.125.245.126"], "Online": true,
          "sshHostKeys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests host"]},
        "nodekey:bbb": {"HostName": "MBA's MacBook Pro", "DNSName": "mbas-macbook-pro.tail123.ts.net.", "OS": "macOS",
          "TailscaleIPs": ["100.72.82.18"], "Online": false}
      },
      "CurrentTailnet": {"Name": "user@example.com", "MagicDNSSuffix": "tail123.ts.net"},
      "Health": null
    }"#;

    #[test]
    fn parses_peers_and_prefers_ipv4() {
        let s = parse_status(SAMPLE.as_bytes()).unwrap();
        assert_eq!(s.backend_state, "Running");
        assert_eq!(s.auth_url, None);
        assert_eq!(s.self_node.as_ref().unwrap().id, "desktop-j0pimak");
        assert_eq!(s.peers.len(), 2);
        let spark = &s.peers[0];
        assert_eq!(spark.id, "spark2");
        assert!(spark.online && spark.has_tailscale_ssh());
        assert_eq!(spark.preferred_ip(), Some("100.125.245.126"));
        let mac = &s.peers[1];
        assert_eq!(mac.id, "mbas-macbook-pro");
        assert!(!mac.has_tailscale_ssh());
        assert_eq!(s.tailnet_name.as_deref(), Some("user@example.com"));
    }

    #[test]
    fn a_machines_view_is_turned_around() {
        // What spark2 answers when this device (100.72.82.18, the Mac in SAMPLE) asks.
        let from_spark2 = SAMPLE
            .replace(r#""Self": {"HostName": "DESKTOP-J0PIMAK""#, r#""Self": {"HostName": "spark2-self""#)
            .replace("desktop-j0pimak.tail123", "spark2x.tail123");
        let output = format!("Last login: somewhere\nchm-client 100.72.82.18\n{from_spark2}");
        let s = parse_remote(output.as_bytes(), "spark2x").unwrap();
        assert_eq!(s.via.as_deref(), Some("spark2x"));
        let me = s.self_node.as_ref().expect("this device found by its address");
        assert_eq!(me.id, "mbas-macbook-pro");
        assert!(me.is_self);
        assert!(s.peers.iter().any(|p| p.id == "spark2x" && !p.is_self), "the machine asked is a peer now");
        assert!(!s.peers.iter().any(|p| p.id == "mbas-macbook-pro"), "and this device isn't");

        // No SSH_CLIENT (or an address nobody has): no self, everyone's a peer.
        let s = parse_remote(format!("chm-client \n{SAMPLE}").as_bytes(), "x").unwrap();
        assert!(s.self_node.is_none());
        assert_eq!(s.peers.len(), 3);
        assert!(parse_remote(b"no tailscale here", "x").is_err());
    }

    #[test]
    fn surfaces_login_url() {
        let s = parse_status(
            br#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/abc","Self":null,"Peer":null}"#,
        )
        .unwrap();
        assert_eq!(s.backend_state, "NeedsLogin");
        assert_eq!(s.auth_url.as_deref(), Some("https://login.tailscale.com/a/abc"));
        assert!(s.peers.is_empty());
    }
}
