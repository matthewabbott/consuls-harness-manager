//! consuls-daemon: see the library docs, and docs/DAEMON.md for setting it up.
//!
//!   consuls-daemon run                                 watch, push, serve the app
//!   consuls-daemon add-host <id> <user> [--key PATH]   watch another machine (restart to apply)
//!   consuls-daemon remove-host <id>
//!   consuls-daemon hosts
//!   consuls-daemon vapid-public-key
//!   consuls-daemon probe [seconds]                     start the core, wait, print what it sees
//!
//! The data folder is `$CONSULS_DAEMON_DIR`, else `~/.local/share/consuls-daemon`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use chm_core::model::{Alert, AppConfig, AuthMode, CoreEvent, HostConfig};
use chm_core::{Core, Sink};
use chm_daemon::config::{self, DaemonConfig};
use tracing::info;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,russh=warn".into()))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = config::data_dir();
    let runtime = || tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build();
    match args.first().map(String::as_str) {
        Some("--version") => println!("consuls-daemon {}", env!("CARGO_PKG_VERSION")),
        Some("run") => runtime()?.block_on(run(dir))?,
        Some("add-host") => {
            let (Some(id), Some(user)) = (args.get(1), args.get(2)) else { bail!("usage: consuls-daemon add-host <id> <user> [--key PATH]") };
            let key = args.iter().position(|a| a == "--key").and_then(|i| args.get(i + 1));
            add_host(&dir, id, user, key.cloned())?;
        }
        Some("remove-host") => {
            let Some(id) = args.get(1) else { bail!("usage: consuls-daemon remove-host <id>") };
            let mut cfg = load_hosts(&dir)?;
            cfg.hosts.retain(|h| &h.id != id);
            save_hosts(&dir, &cfg)?;
            println!("removed {id}; restart the daemon to apply");
        }
        Some("hosts") => {
            for h in load_hosts(&dir)?.hosts {
                println!("{} ({}@{})", h.id, h.user, h.address.as_deref().unwrap_or(&h.id));
            }
        }
        Some("vapid-public-key") => {
            let cfg = DaemonConfig::load(&dir)?;
            let vapid = chm_daemon::push::vapid::Vapid::load_or_create(&dir.join("vapid.json"), cfg.vapid_subject.unwrap_or_default())?;
            println!("{}", vapid.public_key());
        }
        Some("probe") => {
            let secs = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5);
            runtime()?.block_on(probe(secs))?;
        }
        _ => {
            eprintln!("usage: consuls-daemon run | add-host <id> <user> [--key PATH] | remove-host <id> | hosts | vapid-public-key | probe [secs] | --version");
            std::process::exit(2);
        }
    }
    Ok(())
}

async fn run(dir: PathBuf) -> anyhow::Result<()> {
    let daemon = chm_daemon::start(dir).await?;
    let listener = tokio::net::TcpListener::bind(&daemon.config.listen).await.with_context(|| format!("listening on {}", daemon.config.listen))?;
    info!("API on http://{} (publish it with: tailscale serve --bg --https=443 http://{})", daemon.config.listen, daemon.config.listen);
    axum::serve(listener, chm_daemon::http::router(daemon)).with_graceful_shutdown(shutdown()).await?;
    info!("stopped");
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

fn load_hosts(dir: &Path) -> anyhow::Result<AppConfig> {
    match std::fs::read_to_string(dir.join("config.json")) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppConfig::default()),
        Err(e) => Err(e.into()),
    }
}

fn save_hosts(dir: &Path, cfg: &AppConfig) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    chm_daemon::files::write_private(&dir.join("config.json"), serde_json::to_string_pretty(cfg)?.as_bytes())
}

fn add_host(dir: &Path, id: &str, user: &str, key: Option<String>) -> anyhow::Result<()> {
    let me = tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(config::me());
    if me.as_ref().is_some_and(|m| m.id.eq_ignore_ascii_case(id)) {
        bail!("{id} is this machine: its tmux is already watched (as @local)");
    }
    let mut cfg = load_hosts(dir)?;
    cfg.hosts.retain(|h| h.id != id);
    let mut host = HostConfig::new(id, user);
    if let Some(path) = key {
        host.auth = AuthMode::KeyFile { path };
    }
    cfg.hosts.push(host);
    save_hosts(dir, &cfg)?;
    println!("added {id} ({user}); restart the daemon to apply");
    Ok(())
}

/// Discards frames (nothing draws tiles here) and logs alerts.
struct LogSink;

impl Sink for LogSink {
    fn event(&self, _event: CoreEvent) {}
    fn frame(&self, _frame: Vec<u8>) {}
    fn alert(&self, alert: Alert) {
        info!(kind = ?alert.kind, "alert: {} — {}", alert.title, alert.body);
    }
}

/// Starts the core on a throwaway data dir, waits, and prints what it found.
async fn probe(secs: u64) -> anyhow::Result<()> {
    let dir: PathBuf = std::env::temp_dir().join(format!("consuls-daemon-probe-{}", std::process::id()));
    let core = Core::new(dir.clone(), Arc::new(LogSink));
    core.start();
    core.set_visible_panes(Some(Vec::new()));
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let snap = core.snapshot();
    let tailnet = &snap.tailnet;
    println!("tailnet: {} ({} peers){}", tailnet.backend_state, tailnet.peers.len(), tailnet.error.as_deref().map(|e| format!(" error: {e}")).unwrap_or_default());
    if let Some(me) = &tailnet.self_node {
        println!("self: {} ({})", me.id, me.dns_name);
    }
    for host in &snap.hosts {
        let facts = host.facts.as_ref().map(|f| format!("{} · {} · tmux {}", f.user, f.uname, f.tmux_version.as_deref().unwrap_or("none"))).unwrap_or_default();
        println!("host {}: {:?} {facts}", host.id, host.phase);
    }
    println!("panes: {}", snap.panes.len());
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
