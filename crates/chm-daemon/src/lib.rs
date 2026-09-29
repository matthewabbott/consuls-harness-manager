//! consuls-daemon: chm-core without a UI, on an always-on machine. It watches the agents on this
//! machine's tmux and on the machines in its `config.json`, and pushes to your phone when a
//! tracked one is still waiting for you (see `chm_core::notify`). It also serves the phone's
//! web app and its API, behind `tailscale serve`.

pub mod config;
pub mod files;
pub mod http;
pub mod push;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chm_core::model::{Alert, AlertKind, AppConfig, CoreEvent, HostPhase};
use chm_core::notify::{Policy, Push};
use chm_core::{Core, Sink};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{info, warn};

use config::{DaemonConfig, Me};
use push::store::Store;
use push::vapid::Vapid;
use push::{Payload, Sender, Urgency};

pub struct Daemon {
    pub core: Arc<Core>,
    pub policy: Mutex<Policy>,
    pub sender: Arc<Sender>,
    pub config: DaemonConfig,
    /// This machine on the tailnet.
    pub me: Me,
    /// Tailscale logins allowed to use the API.
    pub owners: Vec<String>,
    /// The web app's address as the phone sees it.
    pub origin: String,
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

/// Starts the daemon on `dir` (must run inside a tokio runtime): the core, the push policy and
/// its sender. The API is [`http::router`].
pub async fn start(dir: PathBuf) -> anyhow::Result<Arc<Daemon>> {
    std::fs::create_dir_all(&dir)?;
    let config = DaemonConfig::load(&dir)?;
    let me = config::me().await.unwrap_or_default();
    if me.id.is_empty() {
        warn!("Tailscale didn't say who this machine is; set publicOrigin and ownerLogins in daemon.json");
    }
    skip_self(&dir, &me.id)?;
    let owners = if config.owner_logins.is_empty() { me.login.clone().into_iter().collect() } else { config.owner_logins.clone() };
    let origin = config.public_origin.clone().unwrap_or_else(|| format!("https://{}", me.dns_name));
    let subject = config.vapid_subject.clone().unwrap_or_else(|| origin.clone());
    let vapid = Vapid::load_or_create(&dir.join("vapid.json"), subject)?;
    let store = Arc::new(Store::load(dir.join("subscriptions.json"))?);
    let sender = Arc::new(Sender::new(vapid, store, config.allow_insecure_endpoints)?);

    let (tx, rx) = mpsc::unbounded_channel();
    let core = Core::new(dir.clone(), Arc::new(DaemonSink(tx)));
    core.start();
    // Nothing draws tiles here.
    core.set_visible_panes(Some(Vec::new()));
    let policy = Mutex::new(Policy::new(config.delays()));
    info!("watching as {} for {}; the app is at {origin}", if me.id.is_empty() { "?" } else { &me.id }, owners.join(", "));
    let daemon = Arc::new(Daemon { core, policy, sender, config, me, owners, origin });
    tokio::spawn(drive(daemon.clone(), rx));
    tokio::spawn(revive(daemon.clone()));
    Ok(daemon)
}

/// The daemon's own machine is `@local`; watching it over SSH as well would push everything twice.
fn skip_self(dir: &Path, me: &str) -> anyhow::Result<()> {
    let path = dir.join("config.json");
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(()) };
    let mut cfg: AppConfig = serde_json::from_str(&text)?;
    let before = cfg.hosts.len();
    cfg.hosts.retain(|h| me.is_empty() || !h.id.eq_ignore_ascii_case(me));
    if cfg.hosts.len() != before {
        warn!("{me} is this machine (watched as @local); dropped it from the hosts");
        files::write_private(&path, serde_json::to_string_pretty(&cfg)?.as_bytes())?;
    }
    Ok(())
}

/// Feeds the policy and sends what it decides, when it decides.
async fn drive(d: Arc<Daemon>, mut rx: mpsc::UnboundedReceiver<Input>) {
    let mut asked: HashSet<String> = HashSet::new();
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
                            body: "Tailscale wants a check before the push daemon can watch it.".into(),
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

/// This process's memory use (Linux), for the app's status line.
pub fn rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|l| l.strip_prefix("VmRSS:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
}
