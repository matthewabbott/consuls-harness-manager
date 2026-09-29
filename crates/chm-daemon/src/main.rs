//! consuls-notifier: see the library docs, and docs/NOTIFIER.md.
//!
//!   consuls-notifier run                  wait for a configuration, then watch and push
//!   consuls-notifier ctl configure        the configuration (JSON) on stdin
//!   consuls-notifier ctl renew [days]     check in: the lease runs from now
//!   consuls-notifier ctl status | subscriptions | export | stop
//!   consuls-notifier ctl set-subscriptions   (JSON array on stdin)
//!   consuls-notifier import-legacy <dir>  a configuration from the old push daemon's files
//!   consuls-notifier new-key              a new VAPID private key
//!   consuls-notifier probe [seconds]      start a core, wait, print what it sees
//!
//! Its run folder (and control socket) is `$CONSULS_NOTIFIER_DIR`, else `/tmp/consuls-<uid>`.

#[cfg(not(unix))]
fn main() {
    eprintln!("consuls-notifier runs on macOS and Linux");
    std::process::exit(2);
}

#[cfg(unix)]
fn main() -> anyhow::Result<()> {
    use std::io::Read;
    use std::time::Duration;

    use anyhow::bail;
    use chm_daemon::ctl::{self, Request};
    use chm_daemon::rundir::RunDir;

    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,russh=warn".into()))
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = || tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build();
    let stdin_json = || -> anyhow::Result<serde_json::Value> {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        Ok(serde_json::from_str(&text)?)
    };
    match args.first().map(String::as_str) {
        Some("--version") => println!("consuls-notifier {}", env!("CARGO_PKG_VERSION")),
        Some("run") => {
            let dir = RunDir::prepare(RunDir::default_path())?;
            runtime()?.block_on(chm_daemon::run(dir, Duration::from_secs(60)))?;
        }
        Some("ctl") => {
            let req = match args.get(1).map(String::as_str) {
                Some("configure") => Request::Configure { config: Box::new(serde_json::from_value(stdin_json()?)?) },
                Some("renew") => Request::Renew { days: args.get(2).map(|d| d.parse()).transpose()? },
                Some("status") => Request::Status,
                Some("subscriptions") => Request::Subscriptions,
                Some("set-subscriptions") => Request::SetSubscriptions { subscriptions: serde_json::from_value(stdin_json()?)? },
                Some("export") => Request::Export,
                Some("stop") => Request::Stop,
                _ => bail!("usage: consuls-notifier ctl configure | renew [days] | status | subscriptions | set-subscriptions | export | stop"),
            };
            let socket = RunDir::default_path().join("ctl.sock");
            let data = runtime()?.block_on(ctl::request(&socket, &req))?;
            if !data.is_null() {
                println!("{}", serde_json::to_string_pretty(&data)?);
            }
        }
        Some("import-legacy") => {
            let Some(dir) = args.get(1) else { bail!("usage: consuls-notifier import-legacy <dir>") };
            println!("{}", serde_json::to_string_pretty(&chm_daemon::config::import_legacy(std::path::Path::new(dir))?)?);
        }
        Some("new-key") => println!("{}", chm_daemon::push::vapid::Vapid::generate_key()),
        Some("probe") => {
            let secs = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5);
            runtime()?.block_on(probe(secs))?;
        }
        _ => {
            eprintln!("usage: consuls-notifier run | ctl <verb> | import-legacy <dir> | new-key | probe [secs] | --version");
            std::process::exit(2);
        }
    }
    Ok(())
}

/// Starts a core on a throwaway data folder, waits, and prints what it found.
#[cfg(unix)]
async fn probe(secs: u64) -> anyhow::Result<()> {
    use std::sync::Arc;

    use chm_core::model::{Alert, CoreEvent};
    use chm_core::{Core, Sink};

    struct LogSink;
    impl Sink for LogSink {
        fn event(&self, _event: CoreEvent) {}
        fn frame(&self, _frame: Vec<u8>) {}
        fn alert(&self, alert: Alert) {
            tracing::info!(kind = ?alert.kind, "alert: {} — {}", alert.title, alert.body);
        }
    }

    let dir = std::env::temp_dir().join(format!("consuls-notifier-probe-{}", std::process::id()));
    let core = Core::new(dir.clone(), Arc::new(LogSink));
    core.start();
    core.set_visible_panes(Some(Vec::new()));
    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
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
