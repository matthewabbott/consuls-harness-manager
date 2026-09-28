//! One SSH connection per host (russh), carrying every channel we need: tmux control
//! clients, SFTP, the event tail, and one-off commands. Keeping a single connection per
//! host also minimises Tailscale SSH "check" prompts.

pub mod exec;
pub mod hostkeys;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::agent::client::AgentClient;
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::model::{AuthMode, HostId};
use hostkeys::{KnownHosts, Verdict};

pub type Channel = russh::Channel<client::Msg>;

#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host_id: HostId,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMode,
    /// OpenSSH-format host keys advertised by Tailscale. Empty for non-Tailscale-SSH hosts.
    pub pinned_keys: Vec<String>,
}

/// Things that happen during connect that the UI should hear about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshNotice {
    /// Tailscale SSH check mode: the user has to open this URL to approve the login.
    TailscaleCheck { url: String },
    Banner(String),
    HostKeyTrusted { fingerprint: String },
}

#[derive(thiserror::Error, Debug)]
pub enum SshError {
    #[error("couldn't reach {0}")]
    Network(String),
    #[error("host key mismatch: server presented {presented}, expected {expected:?}")]
    HostKeyMismatch { presented: String, expected: Vec<String> },
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("connection closed")]
    Closed,
    #[error(transparent)]
    Ssh(#[from] russh::Error),
    #[error("sftp: {0}")]
    Sftp(String),
    #[error("{0}")]
    Other(String),
}

impl SshError {
    /// Errors that retrying won't fix without the user doing something.
    pub fn is_fatal(&self) -> bool {
        matches!(self, SshError::HostKeyMismatch { .. } | SshError::Auth(_))
    }
}

/// Extracts the approval URL from a Tailscale SSH check-mode banner, e.g.
/// `# To authenticate, visit: https://login.tailscale.com/a/l867646a31d923`.
pub fn tailscale_check_url(banner: &str) -> Option<String> {
    if !banner.to_ascii_lowercase().contains("tailscale") {
        return None;
    }
    banner
        .split_whitespace()
        .find(|w| w.starts_with("https://"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

struct Handler {
    host_id: HostId,
    pinned: Vec<String>,
    known_hosts: Arc<KnownHosts>,
    notices: mpsc::UnboundedSender<SshNotice>,
    verdict: Arc<Mutex<Option<Verdict>>>,
    closed: watch::Sender<Option<String>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let verdict = self.known_hosts.verify(&self.host_id, &key, &self.pinned);
        let ok = !matches!(verdict, Verdict::Mismatch { .. });
        if let Verdict::NewlyTrusted { fingerprint } = &verdict {
            let _ = self.notices.send(SshNotice::HostKeyTrusted { fingerprint: fingerprint.clone() });
        }
        *self.verdict.lock().unwrap() = Some(verdict);
        Ok(ok)
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        debug!(host = %self.host_id, "auth banner: {banner:?}");
        let notice = match tailscale_check_url(banner) {
            Some(url) => SshNotice::TailscaleCheck { url },
            None => SshNotice::Banner(banner.to_string()),
        };
        let _ = self.notices.send(notice);
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let desc = format!("{reason:?}");
        info!(host = %self.host_id, "ssh disconnected: {desc}");
        let _ = self.closed.send(Some(desc));
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(e) => Err(e),
        }
    }
}

pub struct SshConnection {
    pub host_id: HostId,
    handle: client::Handle<Handler>,
    closed: watch::Receiver<Option<String>>,
}

impl SshConnection {
    pub async fn connect(
        params: &ConnectParams,
        known_hosts: Arc<KnownHosts>,
        notices: mpsc::UnboundedSender<SshNotice>,
    ) -> Result<Self, SshError> {
        let config = Arc::new(client::Config {
            // Dead links are detected by keepalives, not inactivity: an idle agent session
            // can legitimately be silent for hours.
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            nodelay: true,
            channel_buffer_size: 1024,
            ..Default::default()
        });
        let verdict = Arc::new(Mutex::new(None));
        let (closed_tx, closed_rx) = watch::channel(None);
        let handler = Handler {
            host_id: params.host_id.clone(),
            pinned: params.pinned_keys.clone(),
            known_hosts,
            notices,
            verdict: verdict.clone(),
            closed: closed_tx,
        };

        let addr = (params.address.as_str(), params.port);
        let mut handle =
            match tokio::time::timeout(Duration::from_secs(20), client::connect(config, addr, handler))
                .await
            {
                Err(_) => return Err(SshError::Timeout(format!("connecting to {}", params.address))),
                Ok(Err(e)) => {
                    if let Some(Verdict::Mismatch { presented, expected }) = verdict.lock().unwrap().take() {
                        return Err(SshError::HostKeyMismatch { presented, expected });
                    }
                    return Err(match e {
                        russh::Error::IO(io) => SshError::Network(format!("{}: {io}", params.address)),
                        other => SshError::Ssh(other),
                    });
                }
                Ok(Ok(h)) => h,
            };

        authenticate(&mut handle, params).await?;
        info!(host = %params.host_id, "ssh authenticated as {}", params.user);
        Ok(Self { host_id: params.host_id.clone(), handle, closed: closed_rx })
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed() || self.closed.borrow().is_some()
    }

    /// Resolves once the connection has gone away.
    pub async fn closed(&self) {
        let mut rx = self.closed.clone();
        loop {
            if rx.borrow().is_some() || self.handle.is_closed() {
                return;
            }
            tokio::select! {
                changed = rx.changed() => if changed.is_err() { return },
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            }
        }
    }

    /// Opens a session channel and runs `command` (no PTY).
    pub async fn open_exec(&self, command: &str) -> Result<Channel, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        Ok(channel)
    }

    pub async fn open_sftp(&self) -> Result<russh_sftp::client::SftpSession, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "bye", "en")
            .await;
    }
}

async fn authenticate(handle: &mut client::Handle<Handler>, p: &ConnectParams) -> Result<(), SshError> {
    let mut tried: Vec<String> = Vec::new();

    if matches!(p.auth, AuthMode::Auto) {
        // Tailscale SSH accepts `none`; in check mode the reply is delayed until the user
        // approves in the browser (URL arrives via `auth_banner`), so allow a long wait.
        let wait = if p.pinned_keys.is_empty() { 30 } else { 600 };
        match tokio::time::timeout(Duration::from_secs(wait), handle.authenticate_none(&p.user)).await {
            Err(_) => return Err(SshError::Timeout("waiting for Tailscale SSH approval".into())),
            Ok(Ok(res)) if res.success() => return Ok(()),
            Ok(Ok(_)) => tried.push("none".into()),
            Ok(Err(e)) => return Err(e.into()),
        }
    }

    if matches!(p.auth, AuthMode::Auto | AuthMode::Agent) {
        match try_agent(handle, &p.user).await {
            Ok(true) => return Ok(()),
            Ok(false) => tried.push("agent".into()),
            Err(e) => {
                debug!("ssh agent unavailable: {e}");
                tried.push(format!("agent ({e})"));
            }
        }
    }

    let key_files: Vec<PathBuf> = match &p.auth {
        AuthMode::KeyFile { path } => vec![PathBuf::from(path)],
        AuthMode::Auto => default_key_files(),
        AuthMode::Agent => vec![],
    };
    for path in key_files {
        let key = match russh::keys::load_secret_key(&path, None) {
            Ok(k) => k,
            Err(e) => {
                tried.push(format!("{} ({e})", path.display()));
                continue;
            }
        };
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let res = handle
            .authenticate_publickey(&p.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await?;
        if res.success() {
            return Ok(());
        }
        tried.push(path.display().to_string());
    }

    Err(SshError::Auth(format!("as {} (tried: {})", p.user, tried.join(", "))))
}

fn default_key_files() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .filter(|p| p.is_file())
        .collect()
}

async fn try_agent(handle: &mut client::Handle<Handler>, user: &str) -> Result<bool, SshError> {
    #[cfg(windows)]
    {
        match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(agent) => {
                if auth_with_agent(handle, user, agent).await? {
                    return Ok(true);
                }
            }
            Err(e) => debug!("openssh agent pipe: {e}"),
        }
        match AgentClient::connect_pageant().await {
            Ok(agent) => auth_with_agent(handle, user, agent).await,
            Err(e) => Err(SshError::Other(format!("no ssh-agent or Pageant: {e}"))),
        }
    }
    #[cfg(unix)]
    {
        let agent = AgentClient::connect_env()
            .await
            .map_err(|e| SshError::Other(format!("no ssh-agent: {e}")))?;
        auth_with_agent(handle, user, agent).await
    }
}

async fn auth_with_agent<S>(
    handle: &mut client::Handle<Handler>,
    user: &str,
    mut agent: AgentClient<S>,
) -> Result<bool, SshError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Other(format!("agent: {e}")))?;
    for identity in identities {
        let key = identity.public_key().into_owned();
        let hash = if key.algorithm().is_rsa() {
            handle.best_supported_rsa_hash().await?.flatten()
        } else {
            None
        };
        match handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(res) if res.success() => return Ok(true),
            Ok(_) => {}
            Err(e) => warn!("agent signing failed: {e}"),
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_check_url() {
        let banner = "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/l867646a31d923\n";
        assert_eq!(
            tailscale_check_url(banner).as_deref(),
            Some("https://login.tailscale.com/a/l867646a31d923")
        );
        assert_eq!(tailscale_check_url("# Authentication checked with Tailscale SSH.\n"), None);
        assert_eq!(tailscale_check_url("Welcome! see https://example.com"), None);
    }
}
