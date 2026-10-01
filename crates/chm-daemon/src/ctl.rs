//! The server's control socket (`ctl.sock` in its run folder): how `consuls-server start/stop/
//! status` and `scripts/server.sh` (over SSH) talk to a running server. One JSON request per
//! line, one reply; only the server's own user may connect.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;
use tracing::{debug, warn};
use ts_rs::TS;

use crate::Daemon;
use crate::lease::Lease;
use crate::push::store::Subscription;

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename = "ServerRequest")]
pub enum Request {
    /// Checks in: the lease runs `days` (default: the configured length) from now.
    Renew {
        #[serde(default)]
        #[ts(type = "number | null")]
        days: Option<u64>,
    },
    Status,
    /// The phones it pushes to.
    Subscriptions,
    /// Replaces them.
    SetSubscriptions { subscriptions: Vec<Subscription> },
    /// Its configuration as it stands (the machines and phones included), secrets and all: for
    /// the copy kept on the Mac.
    Export,
    /// Stops it (its files stay; `uninstall` removes them).
    Stop,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the control socket acts on.
pub struct Control {
    /// Set once started.
    pub daemon: OnceLock<Arc<Daemon>>,
    pub lease: Arc<Lease>,
    pub stop: watch::Sender<bool>,
}

impl Control {
    async fn handle(&self, req: Request) -> Result<serde_json::Value, String> {
        let daemon = || self.daemon.get().cloned().ok_or_else(|| "still starting".to_string());
        match req {
            Request::Renew { days } => {
                self.lease.renew(days.map(|d| std::time::Duration::from_secs(d * 86_400)));
                // A check-in is someone using the app or the script.
                if let Some(d) = self.daemon.get() {
                    d.human_here();
                }
                Ok(serde_json::json!({ "leaseUntil": self.lease.until_unix() }))
            }
            Request::Status => Ok(match self.daemon.get() {
                Some(d) => serde_json::to_value(d.status()).map_err(|e| e.to_string())?,
                None => serde_json::json!({ "running": true, "starting": true, "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() }),
            }),
            Request::Subscriptions => serde_json::to_value(daemon()?.sender.store().list()).map_err(|e| e.to_string()),
            Request::SetSubscriptions { subscriptions } => {
                let d = daemon()?;
                for s in &subscriptions {
                    d.sender.check_endpoint(&s.endpoint).map_err(|e| e.to_string())?;
                }
                d.sender.store().replace(subscriptions);
                Ok(serde_json::Value::Null)
            }
            Request::Export => serde_json::to_value(daemon()?.export()).map_err(|e| e.to_string()),
            Request::Stop => {
                let _ = self.stop.send(true);
                Ok(serde_json::Value::Null)
            }
        }
    }
}

/// Listens on `socket`. Refuses if a server already answers there; a leftover socket file from
/// one that died is replaced.
pub async fn bind(socket: &Path) -> anyhow::Result<UnixListener> {
    if socket.exists() {
        if UnixStream::connect(socket).await.is_ok() {
            bail!("the Consuls server is already running ({})", socket.display());
        }
        std::fs::remove_file(socket)?;
    }
    Ok(UnixListener::bind(socket)?)
}

pub async fn serve(listener: UnixListener, control: Arc<Control>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                warn!("control socket: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
        };
        let control = control.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(stream, &control).await {
                debug!("control request: {e:#}");
            }
        });
    }
}

async fn handle(stream: UnixStream, control: &Control) -> anyhow::Result<()> {
    // Only this user (the folder is 0700 too).
    // SAFETY: getuid has no failure mode.
    let me = unsafe { libc::getuid() };
    if stream.peer_cred().map(|c| c.uid()).ok() != Some(me) {
        bail!("refused a connection from another user");
    }
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    BufReader::new(read.take(4 << 20)).read_line(&mut line).await?;
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(req) => match control.handle(req).await {
            Ok(data) => Reply { ok: true, data, error: None },
            Err(e) => Reply { ok: false, data: serde_json::Value::Null, error: Some(e) },
        },
        Err(e) => Reply { ok: false, data: serde_json::Value::Null, error: Some(format!("bad request: {e}")) },
    };
    write.write_all(format!("{}\n", serde_json::to_string(&reply)?).as_bytes()).await?;
    write.shutdown().await?;
    Ok(())
}

/// Sends one request to the server listening on `socket` and returns its data.
pub async fn request(socket: &Path, req: &Request) -> anyhow::Result<serde_json::Value> {
    let stream = UnixStream::connect(socket).await.with_context(|| format!("the Consuls server isn't running (no {})", socket.display()))?;
    let (read, mut write) = stream.into_split();
    write.write_all(format!("{}\n", serde_json::to_string(req)?).as_bytes()).await?;
    let mut line = String::new();
    BufReader::new(read.take(64 << 20)).read_line(&mut line).await?;
    let reply: Reply = serde_json::from_str(&line).context("bad reply")?;
    match reply.error {
        None if reply.ok => Ok(reply.data),
        e => bail!("{}", e.unwrap_or_else(|| "failed".into())),
    }
}
