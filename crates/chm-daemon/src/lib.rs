//! consuls-notifier: chm-core without a UI, run for a while on a machine by whoever starts it
//! (the phone app over SSH, or `scripts/notifier.sh`), inside tmux. It watches that machine's
//! agents (and, on the web app's home, the machines it's given) and pushes to your phone when a
//! tracked one is still waiting for you (see `chm_core::notify`).
//!
//! It's transient: it's configured over its control socket (`ctl`), keeps that configuration,
//! secrets included, in memory, and its only files are its run folder in `/tmp`, removed when it
//! stops — at reboot, when told to, or when nobody has checked in for its lease (7 days).
#![cfg(unix)]

pub mod config;
pub mod ctl;
pub mod http;
pub mod lease;
pub mod push;
pub mod rundir;
pub mod serve;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chm_core::model::{Alert, AlertKind, AppConfig, CoreEvent, HostConfig, HostPhase};
use chm_core::notify::{Policy, Push};
use chm_core::{Core, Sink};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tracing::{info, warn};
use ts_rs::TS;

use config::{Me, NotifierConfig};
use ctl::Control;
use lease::Lease;
use push::store::Store;
use push::vapid::Vapid;
use push::{Payload, Sender, Urgency};
use rundir::RunDir;

pub struct Daemon {
    pub core: Arc<Core>,
    pub policy: Mutex<Policy>,
    pub sender: Arc<Sender>,
    /// As configured (the live subscriptions are the sender's).
    pub config: NotifierConfig,
    /// This machine on the tailnet.
    pub me: Me,
    /// This machine's name in pushes and in the app.
    pub self_name: String,
    /// Tailscale logins allowed into the web app.
    pub owners: Vec<String>,
    /// The web app's address as the phone sees it.
    pub origin: String,
    pub lease: Arc<Lease>,
    pub started: u64,
    /// Where the API listens, once it does.
    pub web_url: Mutex<Option<String>>,
}

/// What `ctl status` says.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotifierStatus {
    pub configured: bool,
    pub version: String,
    pub pid: u32,
    pub self_name: String,
    #[ts(type = "number")]
    pub started: u64,
    /// When it stops unless someone checks in (unix seconds).
    #[ts(type = "number")]
    pub lease_until: u64,
    /// The machines it watches, with their state.
    pub watching: Vec<String>,
    pub subscriptions: usize,
    pub pending: usize,
    #[ts(type = "number | null")]
    pub rss_kb: Option<u64>,
    /// The API's local address, when it serves the web app.
    pub web: Option<String>,
}

impl Daemon {
    pub fn status(&self) -> NotifierStatus {
        let snapshot = self.core.snapshot();
        let watching = snapshot
            .hosts
            .iter()
            .map(|h| {
                let name = if h.id == chm_core::local::LOCAL_HOST { self.self_name.clone() } else { h.id.clone() };
                let phase = match &h.phase {
                    HostPhase::Connected => "connected".to_string(),
                    HostPhase::AwaitingTailscaleCheck { url } => format!("waiting for Tailscale SSH approval: {url}"),
                    other => format!("{other:?}").to_lowercase(),
                };
                format!("{name}: {phase}")
            })
            .collect();
        NotifierStatus {
            configured: true,
            version: env!("CARGO_PKG_VERSION").into(),
            pid: std::process::id(),
            self_name: self.self_name.clone(),
            started: self.started,
            lease_until: self.lease.until_unix(),
            watching,
            subscriptions: self.sender.store().list().len(),
            pending: self.policy.lock().unwrap().pending(Instant::now()).len(),
            rss_kb: rss_kb(),
            web: self.web_url.lock().unwrap().clone(),
        }
    }

    /// Its configuration as it stands (subscriptions added since included): for whoever keeps it.
    pub fn export(&self) -> NotifierConfig {
        NotifierConfig { subscriptions: self.sender.store().list(), ..self.config.clone() }
    }
}

enum Input {
    Event(Box<CoreEvent>),
    Alert(Box<Alert>),
}

/// Passes what the policy needs to the driver; tiles are never drawn here.
struct DaemonSink(mpsc::UnboundedSender<Input>);

impl Sink for DaemonSink {
    fn event(&self, event: CoreEvent) {
        if matches!(
            event,
            CoreEvent::Panes { .. } | CoreEvent::Attention { .. } | CoreEvent::Host { .. } | CoreEvent::HostRemoved { .. } | CoreEvent::Tailnet { .. }
        ) {
            let _ = self.0.send(Input::Event(Box::new(event)));
        }
    }
    fn frame(&self, _frame: Vec<u8>) {}
    fn alert(&self, alert: Alert) {
        let _ = self.0.send(Input::Alert(Box::new(alert)));
    }
}

/// Runs a notifier in `dir`: waits (up to `configure_within`) for its configuration on the
/// control socket, then watches and pushes until it's stopped, and removes `dir`.
pub async fn run(dir: RunDir, configure_within: Duration) -> anyhow::Result<()> {
    // Before this, the folder may be another notifier's.
    let listener = ctl::bind(&dir.socket()).await?;
    cleanup_on_panic(dir.path().to_owned());
    let (config_tx, config_rx) = oneshot::channel();
    let (stop_tx, stop_rx) = watch::channel(false);
    let lease = Arc::new(Lease::new(Duration::from_secs(7 * 86_400)));
    let control = Arc::new(Control { configure: Mutex::new(Some(config_tx)), daemon: OnceLock::new(), lease: lease.clone(), stop: stop_tx.clone() });
    tokio::spawn(ctl::serve(listener, control.clone()));
    info!("waiting for a configuration on {}", dir.socket().display());

    let mut stopped = stop_rx.clone();
    let config = tokio::select! {
        config = config_rx => config.ok(),
        _ = tokio::time::sleep(configure_within) => {
            info!("nobody configured me within {} s; leaving", configure_within.as_secs());
            None
        }
        _ = signals() => None,
        _ = stopped.changed() => None,
    };
    let Some((config, started)) = config else {
        leave(&dir);
        return Ok(());
    };
    lease.set_length(config.lease());
    let web = config.web.clone();
    let begun = async {
        // The API's port first: a clash is an answer to Configure, not a surprise later.
        let api = match web.as_ref() {
            Some(w) => {
                let listener = tokio::net::TcpListener::bind(w.listen.as_deref().unwrap_or("127.0.0.1:0")).await?;
                let port = listener.local_addr()?.port();
                Some((listener, port))
            }
            None => None,
        };
        anyhow::Ok((start(config, dir.core_dir(), lease.clone()).await?, api))
    };
    let (daemon, api) = match begun.await {
        Ok(d) => d,
        Err(e) => {
            let _ = started.send(Err(format!("{e:#}")));
            // Let the reply go out before the socket does.
            tokio::time::sleep(Duration::from_millis(200)).await;
            leave(&dir);
            return Err(e);
        }
    };
    let _ = control.daemon.set(daemon.clone());

    if let (Some(web), Some((listener, port))) = (web, api) {
        *daemon.web_url.lock().unwrap() = Some(format!("http://127.0.0.1:{port}"));
        let router = http::router(daemon.clone());
        let mut stopped = stop_rx.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.changed().await;
                })
                .await;
        });
        if web.tailscale_serve {
            tokio::spawn(serve::keep_serving(port, web.https_port, stop_rx.clone()));
        }
    }
    let _ = started.send(Ok(()));

    // macOS's /tmp cleaner deletes files untouched for three days.
    let touch_dir = dir.path().to_owned();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(12 * 3600));
        loop {
            tick.tick().await;
            if let Ok(d) = RunDir::prepare(touch_dir.clone()) {
                d.touch();
            }
        }
    });

    let mut stopped = stop_rx.clone();
    let why = tokio::select! {
        _ = signals() => "a signal",
        _ = stopped.changed() => "told to stop",
        _ = lease::expiry(&lease) => "nobody checked in before the lease ran out",
        _ = memory_ceiling() => "it used too much memory",
    };
    info!("stopping: {why}");
    let _ = stop_tx.send(true);
    // Give the tailscale serve child a moment to end (its config goes with it).
    tokio::time::sleep(Duration::from_millis(500)).await;
    leave(&dir);
    Ok(())
}

/// Leaves no trace: the run folder, and (best effort) the private tmux server's socket file,
/// which tmux may leave behind once the notifier's pane — its last — closes.
fn leave(dir: &RunDir) {
    dir.cleanup();
    if let Some(name) = std::env::var("CONSULS_TMUX_NAME").ok().filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        use std::os::unix::process::CommandExt;
        let script = format!("sleep 2; tmux -L {name} has-session 2>/dev/null || rm -f \"${{TMUX_TMPDIR:-/tmp}}/tmux-$(id -u)/{name}\"");
        let _ = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

fn cleanup_on_panic(dir: PathBuf) {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    if DIR.set(dir).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = DIR.get() {
            let _ = std::fs::remove_dir_all(dir);
        }
        previous(info);
    }));
}

async fn signals() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup())) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = hup.recv() => {}
    }
}

/// Without systemd's limits around it, a notifier gone wrong must not eat a machine that's
/// short of memory: it stops above 400 MB (Linux; macOS has no cheap reading).
async fn memory_ceiling() {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if rss_kb().is_some_and(|kb| kb > 400_000) {
            warn!("using {} MB", rss_kb().unwrap_or(0) / 1024);
            return;
        }
    }
}

/// Starts the core, the push policy and its sender, as configured. The API is [`http::router`].
pub async fn start(config: NotifierConfig, core_dir: PathBuf, lease: Arc<Lease>) -> anyhow::Result<Arc<Daemon>> {
    std::fs::create_dir_all(&core_dir)?;
    let me = config::me().await.unwrap_or_default();
    // Never this machine over SSH too: it's already @local, and every push would come twice.
    let hosts: Vec<HostConfig> = config.hosts.iter().filter(|h| me.id.is_empty() || !h.id.eq_ignore_ascii_case(&me.id)).cloned().collect();
    if hosts.len() != config.hosts.len() {
        warn!("{} is this machine (watched as @local); not watching it again", me.id);
    }
    std::fs::write(core_dir.join("config.json"), serde_json::to_string(&AppConfig { hosts, ..Default::default() })?)?;
    let self_name = config.self_name.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| if me.id.is_empty() { "this machine".into() } else { me.id.clone() });
    let web = config.web.clone();
    let owners = web.as_ref().map(|w| w.owner_logins.clone()).filter(|o| !o.is_empty()).unwrap_or_else(|| me.login.clone().into_iter().collect());
    let origin = web.as_ref().and_then(|w| w.public_origin.clone()).unwrap_or_else(|| format!("https://{}", me.dns_name));
    let subject = config.vapid.subject.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| origin.clone());
    let vapid = Vapid::from_base64(&config.vapid.private_key, subject)?;
    let store = Arc::new(Store::new(config.subscriptions.clone()));
    let sender = Arc::new(Sender::new(vapid, store, config.allow_insecure_endpoints)?);

    let (tx, rx) = mpsc::unbounded_channel();
    let core = Core::new(core_dir, Arc::new(DaemonSink(tx)));
    core.start();
    // Nothing draws tiles here.
    core.set_visible_panes(Some(Vec::new()));
    let mut policy = Policy::new(config.delays());
    if let Some(name) = config.self_name.clone().filter(|s| !s.is_empty()) {
        policy.name_this_machine(name);
    }
    let policy = Mutex::new(policy);
    info!("watching as {self_name}{}", if config.web.is_some() { format!("; the web app is at {origin} for {}", owners.join(", ")) } else { String::new() });
    let daemon = Arc::new(Daemon { core, policy, sender, config, me, self_name, owners, origin, lease, started: push::now(), web_url: Mutex::new(None) });
    tokio::spawn(drive(daemon.clone(), rx));
    tokio::spawn(revive(daemon.clone()));
    Ok(daemon)
}

/// Feeds the policy and sends what it decides, when it decides.
async fn drive(d: Arc<Daemon>, mut rx: mpsc::UnboundedReceiver<Input>) {
    let mut asked = std::collections::HashSet::new();
    loop {
        let deadline = d.policy.lock().unwrap().next_deadline();
        let due = async {
            match deadline {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending().await,
            }
        };
        let pushes = tokio::select! {
            input = rx.recv() => match input {
                None => return,
                Some(Input::Event(event)) => {
                    // A machine waits for Tailscale SSH's check: send the approval link.
                    if let CoreEvent::Host { state } = event.as_ref()
                        && let HostPhase::AwaitingTailscaleCheck { url } = &state.phase
                        && asked.insert(url.clone())
                    {
                        info!("{} waits for Tailscale SSH's check: approve it at {url}", state.id);
                        let payload = Payload {
                            title: format!("Approve SSH to {}", state.id),
                            body: "Tailscale wants a check before the notifier can watch it.".into(),
                            tag: format!("tailscale-check:{}", state.id),
                            url: url.clone(),
                        };
                        send(&d, payload, Urgency::High);
                    }
                    d.policy.lock().unwrap().event(&event);
                    Vec::new()
                }
                Some(Input::Alert(alert)) => d.policy.lock().unwrap().alert(&alert, Instant::now(), push::now()),
            },
            _ = due => d.policy.lock().unwrap().due(Instant::now()),
        };
        for p in pushes {
            info!("pushing: {} ({})", p.title, p.host);
            let urgency = if p.kind == AlertKind::NeedsInput { Urgency::High } else { Urgency::Normal };
            send(&d, payload_for(&p), urgency);
        }
    }
}

/// What the phone shows for a push; tapping it opens the pane in the app.
pub fn payload_for(p: &Push) -> Payload {
    Payload { title: p.title.clone(), body: p.body.clone(), tag: p.tag.clone(), url: format!("/#pane={}/{}", p.host, p.pane_id.replace('%', "%25")) }
}

fn send(d: &Arc<Daemon>, payload: Payload, urgency: Urgency) {
    let sender = d.sender.clone();
    tokio::spawn(async move { sender.to_all(&payload, urgency).await });
}

/// A machine that failed for good (auth, host key) stays down until asked again: ask every
/// 10 minutes, in case it was fixed.
async fn revive(d: Arc<Daemon>) {
    let mut tick = tokio::time::interval(Duration::from_secs(600));
    tick.tick().await;
    loop {
        tick.tick().await;
        for host in d.core.snapshot().hosts {
            if matches!(host.phase, HostPhase::Failed { .. }) {
                info!("trying {} again", host.id);
                d.core.connect(&host.id);
            }
        }
    }
}

/// This process's memory use (Linux).
pub fn rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|l| l.strip_prefix("VmRSS:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::ctl::Request;

    fn scratch(name: &str) -> RunDir {
        let path = std::env::temp_dir().join(format!("chm-ctl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        RunDir::prepare(path).unwrap()
    }

    async fn socket_of(dir: &Path) -> PathBuf {
        let socket = dir.join("ctl.sock");
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        socket
    }

    #[tokio::test]
    async fn leaves_when_nobody_configures_it() {
        let dir = scratch("timeout");
        let path = dir.path().to_owned();
        let running = tokio::spawn(run(dir, Duration::from_millis(500)));
        let status = ctl::request(&socket_of(&path).await, &Request::Status).await.unwrap();
        assert_eq!(status["configured"], false);
        assert!(ctl::request(&path.join("ctl.sock"), &Request::Export).await.unwrap_err().to_string().contains("not configured"));
        running.await.unwrap().unwrap();
        assert!(!path.exists(), "its folder is gone");
    }

    #[tokio::test]
    async fn a_configuration_that_cant_start_is_answered_and_cleaned_up() {
        let dir = scratch("bad-key");
        let path = dir.path().to_owned();
        let running = tokio::spawn(run(dir, Duration::from_secs(10)));
        let config = serde_json::from_value(serde_json::json!({
            "vapid": { "privateKey": "not a key" },
            "selfName": "test",
            "web": { "tailscaleServe": false },
        }))
        .unwrap();
        let err = ctl::request(&socket_of(&path).await, &Request::Configure { config: Box::new(config) }).await.unwrap_err();
        assert!(err.to_string().to_lowercase().contains("key"), "{err}");
        assert!(running.await.unwrap().is_err());
        assert!(!path.exists(), "its folder is gone");
    }

    #[tokio::test]
    async fn a_dead_notifiers_socket_is_replaced_and_a_live_one_refused() {
        let dir = scratch("stale");
        let socket = dir.socket();
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert!(socket.exists());
        let live = ctl::bind(&socket).await.expect("a leftover socket is replaced");
        assert!(ctl::bind(&socket).await.unwrap_err().to_string().contains("already running"));
        drop(live);
        dir.cleanup();
    }
}
