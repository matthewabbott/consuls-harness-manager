//! consuls-server: Consuls' core without a window, on one of your machines. It serves the phone's
//! web app (over `tailscale serve`), which drives the core through a WebSocket (`ws.rs`), and it
//! pushes to the phone when a tracked agent is still waiting for you (see `chm_core::notify`).
//!
//! Transient: nothing restarts it. It runs until it's stopped, the machine reboots, or nobody
//! has used it for its lease (7 days), inside a private tmux server. What lasts between runs is
//! its install folder (`home.rs`), so it can be started again by hand (`consuls-server start`,
//! over SSH from a phone), and `consuls-server uninstall` clears it all off.
#![cfg(unix)]

pub mod approvals;
pub mod config;
pub mod ctl;
pub mod downloads;
pub mod home;
pub mod http;
pub mod lease;
pub mod push;
pub mod rpc;
pub mod rundir;
pub mod serve;
pub mod ws;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chm_core::model::{Alert, AlertKind, AppConfig, CoreEvent, HostConfig, HostPhase};
use chm_core::notify::{Policy, Push};
use chm_core::{Core, Sink};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tracing::{info, warn};
use ts_rs::TS;

use config::{Me, ServerConfig};
use ctl::Control;
use home::Home;
use lease::Lease;
use push::store::Store;
use push::vapid::Vapid;
use push::{Payload, Sender, Urgency};
use rundir::RunDir;

pub struct Daemon {
    pub core: Arc<Core>,
    pub policy: Mutex<Policy>,
    pub sender: Arc<Sender>,
    /// As installed (the live machines are the core's, the live phones the sender's).
    pub config: ServerConfig,
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
    /// This run: pane keys are only good within one, so a web app that sees a new one reloads.
    pub instance: String,
    /// Where the API listens, once it does.
    pub web_url: Mutex<Option<String>>,
    pub approvals: Mutex<approvals::Approvals>,
    pub clients: Arc<ws::Clients>,
    pub downloads: downloads::Grants,
}

/// What `consuls-server status` says.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerStatus {
    pub running: bool,
    pub version: String,
    pub pid: u32,
    pub self_name: String,
    #[ts(type = "number")]
    pub started: u64,
    /// When it stops unless someone uses it (unix seconds).
    #[ts(type = "number")]
    pub lease_until: u64,
    /// The machines it watches, with their state.
    pub watching: Vec<String>,
    pub subscriptions: usize,
    pub pending: usize,
    #[ts(type = "number | null")]
    pub rss_kb: Option<u64>,
    /// Where the API listens (a unix socket, or a TCP address).
    pub web: Option<String>,
    /// The web app's address.
    pub origin: String,
}

impl Daemon {
    /// A person showed up (the web app, or a check-in): approval pushes may come again.
    pub fn human_here(&self) {
        self.approvals.lock().unwrap().human(Instant::now().into_std());
    }

    pub fn status(&self) -> ServerStatus {
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
        ServerStatus {
            running: true,
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
            origin: self.origin.clone(),
        }
    }

    /// Its configuration as it stands, with the machines and phones as they are now: for the copy
    /// kept on the Mac.
    pub fn export(&self) -> ServerConfig {
        let hosts = self.core.snapshot().config.hosts;
        ServerConfig { subscriptions: self.sender.store().list(), hosts, ..self.config.clone() }
    }
}

enum Input {
    Event(Box<CoreEvent>),
    Alert(Box<Alert>),
}

/// The core's output: what the push policy needs goes to the driver; everything goes to the web
/// app, if one is connected.
struct DaemonSink {
    policy: mpsc::UnboundedSender<Input>,
    clients: Arc<ws::Clients>,
}

impl Sink for DaemonSink {
    fn event(&self, event: CoreEvent) {
        self.clients.event(&event);
        if matches!(
            event,
            CoreEvent::Panes { .. }
                | CoreEvent::Attention { .. }
                | CoreEvent::Host { .. }
                | CoreEvent::HostRemoved { .. }
                | CoreEvent::Tailnet { .. }
                // The push settings (delays, pause), changed from the app.
                | CoreEvent::Config { .. }
        ) {
            let _ = self.policy.send(Input::Event(Box::new(event)));
        }
    }
    fn frame(&self, frame: Vec<u8>) {
        self.clients.frame(frame);
    }
    fn alert(&self, alert: Alert) {
        let _ = self.policy.send(Input::Alert(Box::new(alert)));
    }
}

/// Runs the server from its install folder until it's stopped, then removes its run folder.
pub async fn run(home: Home, dir: RunDir) -> anyhow::Result<()> {
    // Before this, the run folder may be another server's.
    let listener = ctl::bind(&dir.socket()).await?;
    cleanup_on_panic(dir.path().to_owned());
    let (stop_tx, stop_rx) = watch::channel(false);
    let lease = Arc::new(Lease::new(Duration::from_secs(7 * 86_400)));
    let control = Arc::new(Control { daemon: OnceLock::new(), lease: lease.clone(), stop: stop_tx.clone() });
    tokio::spawn(ctl::serve(listener, control.clone()));

    let started = async {
        let config = home.load_config()?;
        lease.set_length(config.lease());
        let web = config.web.clone();
        let daemon = start(config, &home, lease.clone()).await?;
        if let Some(web) = web {
            let target = serve_web(&daemon, &web, &dir, stop_rx.clone()).await?;
            if web.tailscale_serve {
                tokio::spawn(serve::keep_serving(target, web.https_port, stop_rx.clone()));
            }
        }
        anyhow::Ok(daemon)
    };
    let daemon = match started.await {
        Ok(d) => d,
        Err(e) => {
            leave(&dir);
            return Err(e);
        }
    };
    let _ = control.daemon.set(daemon.clone());

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
        _ = lease::expiry(&lease) => "nobody used it before the lease ran out",
        _ = memory_ceiling() => "it used too much memory",
    };
    info!("stopping: {why}");
    let _ = stop_tx.send(true);
    daemon.core.flush_ui_state();
    // Give the tailscale serve child a moment to end (its config goes with it).
    tokio::time::sleep(Duration::from_millis(500)).await;
    leave(&dir);
    Ok(())
}

/// Starts the API: on a unix socket in the run folder (only this user and `tailscale serve`,
/// which runs as root, can reach it), or on `web.listen` (tests, development). Returns the target
/// for `tailscale serve`.
async fn serve_web(d: &Arc<Daemon>, web: &config::WebConfig, dir: &RunDir, stop: watch::Receiver<bool>) -> anyhow::Result<String> {
    let router = http::router(d.clone());
    let shutdown = |mut stop: watch::Receiver<bool>| async move {
        let _ = stop.changed().await;
    };
    let target = match &web.listen {
        Some(addr) => {
            let listener = tokio::net::TcpListener::bind(addr).await?;
            let addr = listener.local_addr()?;
            tokio::spawn(async move { axum::serve(listener, router).with_graceful_shutdown(shutdown(stop)).await });
            format!("http://{addr}")
        }
        None => {
            let socket = dir.web_socket();
            let _ = std::fs::remove_file(&socket);
            let listener = tokio::net::UnixListener::bind(&socket)?;
            tokio::spawn(async move { axum::serve(listener, router).with_graceful_shutdown(shutdown(stop)).await });
            format!("unix:{}", socket.display())
        }
    };
    *d.web_url.lock().unwrap() = Some(target.clone());
    Ok(target)
}

/// Leaves no trace of this run: the run folder, and (best effort) the private tmux server's
/// socket file, which tmux may leave behind once the server's pane — its last — closes.
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

/// A server gone wrong must not eat a machine that's short of memory: it stops above 400 MB
/// (Linux; macOS has no cheap reading).
async fn memory_ceiling() {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if rss_kb().is_some_and(|kb| kb > 400_000) {
            warn!("using {} MB: stopping (the phone app is gone until it's started again)", rss_kb().unwrap_or(0) / 1024);
            return;
        }
    }
}

/// Starts the core, the push policy and its sender. The API is [`http::router`].
pub async fn start(config: ServerConfig, home: &Home, lease: Arc<Lease>) -> anyhow::Result<Arc<Daemon>> {
    let core_dir = home.core_dir();
    std::fs::create_dir_all(&core_dir)?;
    let me = config::me().await.unwrap_or_default();
    // The machines are the core's own config, edited from the app; the installed config only
    // seeds it. Never this machine over SSH too: it's already @local, and every push would come
    // twice.
    let core_config = core_dir.join("config.json");
    if !core_config.exists() && !config.hosts.is_empty() {
        let hosts: Vec<HostConfig> = config.hosts.iter().filter(|h| me.id.is_empty() || !h.id.eq_ignore_ascii_case(&me.id)).cloned().collect();
        std::fs::write(&core_config, serde_json::to_string_pretty(&AppConfig { hosts, ..Default::default() })?)?;
    }
    let self_name = config.self_name.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| if me.id.is_empty() { "this machine".into() } else { me.id.clone() });
    let web = config.web.clone();
    let owners = web.as_ref().map(|w| w.owner_logins.clone()).filter(|o| !o.is_empty()).unwrap_or_else(|| me.login.clone().into_iter().collect());
    let origin = web.as_ref().and_then(|w| w.public_origin.clone()).unwrap_or_else(|| format!("https://{}", me.dns_name));
    let subject = config.vapid.subject.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| origin.clone());
    let vapid = Vapid::from_base64(&config.vapid.private_key, subject)?;
    let store = Arc::new(Store::open(home.subscriptions_path(), config.subscriptions.clone())?);
    let sender = Arc::new(Sender::new(vapid, store, config.allow_insecure_endpoints)?);

    let (tx, rx) = mpsc::unbounded_channel();
    let clients = ws::Clients::new();
    let core = Core::new(core_dir, Arc::new(DaemonSink { policy: tx, clients: clients.clone() }));
    core.start();
    // Tiles are only drawn for a desktop's grid.
    core.set_visible_panes(Some(Vec::new()));
    // The push settings are the core's (set from the app), and follow its Config events.
    let prefs = core.snapshot().config.notify;
    let mut policy = Policy::new((&prefs).into());
    policy.set_prefs(&prefs, push::now());
    if let Some(name) = config.self_name.clone().filter(|s| !s.is_empty()) {
        policy.name_this_machine(name);
    }
    let policy = Mutex::new(policy);
    info!("serving as {self_name}{}", if config.web.is_some() { format!("; the web app is at {origin} for {}", owners.join(", ")) } else { String::new() });
    let started = push::now();
    let instance = format!("{:x}-{:x}", started, std::process::id());
    let daemon = Arc::new(Daemon {
        core,
        policy,
        sender,
        config,
        me,
        self_name,
        owners,
        origin,
        lease,
        started,
        instance,
        web_url: Mutex::new(None),
        approvals: Default::default(),
        clients,
        downloads: Default::default(),
    });
    tokio::spawn(drive(daemon.clone(), rx));
    tokio::spawn(revive(daemon.clone()));
    Ok(daemon)
}

/// Feeds the policy and sends what it decides, when it decides.
async fn drive(d: Arc<Daemon>, mut rx: mpsc::UnboundedReceiver<Input>) {
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
                    // A machine waits for Tailscale SSH's check: send the approval link (see approvals).
                    if let CoreEvent::Host { state } = event.as_ref()
                        && let HostPhase::AwaitingTailscaleCheck { url } = &state.phase
                        && d.approvals.lock().unwrap().due(&state.id, Instant::now().into_std())
                    {
                        info!("{} waits for Tailscale SSH's check: approve it at {url}", state.id);
                        let payload = Payload {
                            title: format!("Approve SSH to {}", state.id),
                            body: "Tailscale wants a check before Consuls can reach it.".into(),
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
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("chm-srv-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[tokio::test]
    async fn a_configuration_that_cant_start_is_reported_and_cleaned_up() {
        let base = scratch("bad-key");
        let home = Home::open(base.join("home")).unwrap();
        home::write_private(&home.config_path(), br#"{"vapid":{"privateKey":"not a key"},"selfName":"test"}"#).unwrap();
        let dir = RunDir::prepare(base.join("run")).unwrap();
        let err = run(home, dir).await.unwrap_err();
        assert!(err.to_string().to_lowercase().contains("key"), "{err}");
        assert!(!base.join("run").exists(), "its run folder is gone");
        assert!(base.join("home/config.json").exists(), "its install folder stays");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn not_installed() {
        let base = scratch("empty");
        let err = run(Home::open(base.join("home")).unwrap(), RunDir::prepare(base.join("run")).unwrap()).await.unwrap_err();
        assert!(err.to_string().contains("not installed"), "{err}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn a_dead_servers_socket_is_replaced_and_a_live_one_refused() {
        let dir = RunDir::prepare(scratch("stale")).unwrap();
        let socket = dir.socket();
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert!(socket.exists());
        let live = ctl::bind(&socket).await.expect("a leftover socket is replaced");
        assert!(ctl::bind(&socket).await.unwrap_err().to_string().contains("already running"));
        drop(live);
        dir.cleanup();
    }
}
