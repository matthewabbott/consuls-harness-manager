//! The notifier's control socket (`ctl.sock` in its run folder): how whoever started it (the
//! phone app over SSH, or `scripts/notifier.sh`) configures, renews, asks about and stops it.
//! One JSON request per line, one reply; only the notifier's own user may connect.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{oneshot, watch};
use tracing::{debug, warn};
use ts_rs::TS;

use crate::Daemon;
use crate::config::NotifierConfig;
use crate::lease::Lease;
use crate::push::store::Subscription;

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename = "NotifierRequest")]
pub enum Request {
    /// Starts it (once): until then it only waits. Replies once it's running, or why it couldn't.
    Configure { config: Box<NotifierConfig> },
    /// Checks in: the lease runs `days` (default: the configured length) from now.
    Renew {
        #[serde(default)]
        #[ts(type = "number | null")]
        days: Option<u64>,
    },
    Status,
    /// The phones it pushes to (to keep a copy elsewhere).
    Subscriptions,
    /// Replaces them.
    SetSubscriptions { subscriptions: Vec<Subscription> },
    /// Its whole configuration as it stands (subscriptions included), secrets and all.
    Export,
    /// Stops it and removes its files.
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

/// A configuration, and where to say whether it started.
pub type Configured = (NotifierConfig, oneshot::Sender<Result<(), String>>);

/// What the control socket acts on.
pub struct Control {
    /// Taken by the first `Configure`.
    pub configure: Mutex<Option<oneshot::Sender<Configured>>>,
    /// Set once configured and started.
    pub daemon: OnceLock<Arc<Daemon>>,
    pub lease: Arc<Lease>,
    pub stop: watch::Sender<bool>,
}

impl Control {
    async fn handle(&self, req: Request) -> Result<serde_json::Value, String> {
        let daemon = || self.daemon.get().cloned().ok_or_else(|| "not configured yet".to_string());
        match req {
            Request::Configure { config } => {
                let tx = self.configure.lock().unwrap().take().ok_or("already configured")?;
                let (done, started) = oneshot::channel();
                tx.send((*config, done)).map_err(|_| "not accepting a configuration")?;
                started.await.map_err(|_| "stopped before it started".to_string())??;
                Ok(serde_json::Value::Null)
            }
            Request::Renew { days } => {
                self.lease.renew(days.map(|d| std::time::Duration::from_secs(d * 86_400)));
                Ok(serde_json::json!({ "leaseUntil": self.lease.until_unix() }))
            }
            Request::Status => Ok(match self.daemon.get() {
                Some(d) => serde_json::to_value(d.status()).map_err(|e| e.to_string())?,
                None => serde_json::json!({ "configured": false, "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() }),
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

/// Listens on `socket`. Refuses if a notifier already answers there; a leftover socket file
/// from one that died is replaced.
pub async fn bind(socket: &Path) -> anyhow::Result<UnixListener> {
    if socket.exists() {
        if UnixStream::connect(socket).await.is_ok() {
            bail!("a notifier is already running here ({})", socket.display());
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

/// Sends one request to the notifier listening on `socket` and returns its data.
pub async fn request(socket: &Path, req: &Request) -> anyhow::Result<serde_json::Value> {
    let stream = UnixStream::connect(socket).await.with_context(|| format!("no notifier at {}", socket.display()))?;
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
