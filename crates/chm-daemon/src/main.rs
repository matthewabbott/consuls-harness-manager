//! consuls-server: see the library docs, and docs/SERVER.md.
//!
//!   consuls-server start       start it (in a private tmux server) unless it's running
//!   consuls-server stop        stop it (its files stay)
//!   consuls-server status
//!   consuls-server log         the current run's log
//!   consuls-server uninstall   stop it and remove everything it keeps on this machine
//!   consuls-server run         run in the foreground (what `start` runs inside tmux)
//!   consuls-server ctl renew [days] | status | subscriptions | set-subscriptions | export | stop
//!   consuls-server new-key     a new VAPID private key
//!
//! Its install folder is `$CONSULS_SERVER_HOME`, else `~/.local/share/consuls-server`; its run
//! folder (sockets) `$CONSULS_SERVER_RUN`, else `/tmp/consuls-<uid>`.

#[cfg(not(unix))]
fn main() {
    eprintln!("consuls-server runs on macOS and Linux");
    std::process::exit(2);
}

/// The private tmux server it runs in (`$CONSULS_SERVER_TMUX` for tests).
#[cfg(unix)]
fn tmux_name() -> String {
    std::env::var("CONSULS_SERVER_TMUX").ok().filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or_else(|| "consuls-server".into())
}

#[cfg(unix)]
fn main() -> anyhow::Result<()> {
    use std::io::Read;

    use anyhow::bail;
    use chm_daemon::ctl::{self, Request};
    use chm_daemon::home::Home;
    use chm_daemon::rundir::RunDir;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let verb = args.first().map(String::as_str);
    if verb == Some("run") {
        use std::io::IsTerminal;
        tracing_subscriber::fmt()
            .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,russh=warn".into()))
            .with_writer(std::io::stderr)
            // Colours only on a terminal: `start` writes the log to a file.
            .with_ansi(std::io::stderr().is_terminal())
            .init();
    }
    let runtime = || tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build();
    let socket = || RunDir::default_path().join("ctl.sock");
    let ask = |req: Request| -> anyhow::Result<serde_json::Value> { runtime()?.block_on(ctl::request(&socket(), &req)) };
    let print = |v: &serde_json::Value| -> anyhow::Result<()> {
        if !v.is_null() {
            println!("{}", serde_json::to_string_pretty(v)?);
        }
        Ok(())
    };
    match verb {
        Some("--version") => println!("consuls-server {}", env!("CARGO_PKG_VERSION")),
        Some("run") => {
            let home = Home::open(Home::default_path())?;
            let dir = RunDir::prepare(RunDir::default_path())?;
            runtime()?.block_on(chm_daemon::run(home, dir))?;
        }
        Some("start") => start()?,
        Some("stop") => stop()?,
        Some("status") => match ask(Request::Status) {
            Ok(v) => print(&v)?,
            Err(_) => {
                println!("not running; start it with: {} start", std::env::current_exe()?.display());
                std::process::exit(1);
            }
        },
        Some("log") => {
            let log = Home::default_path().join("server.log");
            print!("{}", std::fs::read_to_string(&log).unwrap_or_else(|_| format!("no log at {}\n", log.display())));
        }
        Some("uninstall") => uninstall()?,
        Some("ctl") => {
            let stdin_json = || -> anyhow::Result<serde_json::Value> {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text)?;
                Ok(serde_json::from_str(&text)?)
            };
            let req = match args.get(1).map(String::as_str) {
                Some("renew") => Request::Renew { days: args.get(2).map(|d| d.parse()).transpose()? },
                Some("status") => Request::Status,
                Some("subscriptions") => Request::Subscriptions,
                Some("set-subscriptions") => Request::SetSubscriptions { subscriptions: serde_json::from_value(stdin_json()?)? },
                Some("export") => Request::Export,
                Some("stop") => Request::Stop,
                _ => bail!("usage: consuls-server ctl renew [days] | status | subscriptions | set-subscriptions | export | stop"),
            };
            print(&ask(req)?)?;
        }
        Some("new-key") => println!("{}", chm_daemon::push::vapid::Vapid::generate_key()),
        _ => {
            eprintln!("usage: consuls-server start | stop | status | log | uninstall | run | ctl <verb> | new-key | --version");
            std::process::exit(2);
        }
    }
    Ok(())
}

/// tmux: on PATH, else where it usually is (a login shell over SSH may not have Homebrew's).
#[cfg(unix)]
fn tmux() -> anyhow::Result<std::path::PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("tmux")).find(|p| p.is_file()));
    on_path
        .or_else(|| ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].into_iter().map(std::path::PathBuf::from).find(|p| p.is_file()))
        .ok_or_else(|| anyhow::anyhow!("tmux isn't installed here"))
}

#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Starts the server in its private tmux server (unless it's running), and waits until it serves.
#[cfg(unix)]
fn start() -> anyhow::Result<()> {
    use std::time::{Duration, Instant};

    use chm_daemon::ctl::{self, Request};
    use chm_daemon::home::Home;
    use chm_daemon::rundir::RunDir;

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let socket = RunDir::default_path().join("ctl.sock");
    if let Ok(status) = rt.block_on(ctl::request(&socket, &Request::Status)) {
        println!("already running\n{}", serde_json::to_string_pretty(&status)?);
        return Ok(());
    }
    let home = Home::open(Home::default_path())?;
    home.load_config()?;
    let exe = std::env::current_exe()?;
    let log = home.path().join("server.log");
    // A new log each run, created private (a truncated old one would keep its mode).
    let _ = std::fs::remove_file(&log);
    // Its own environment, not the tmux pane's it might be started from; the test overrides pass.
    let name = tmux_name();
    let mut env = format!("CONSULS_TMUX_NAME={name} MALLOC_ARENA_MAX=2 RUST_LOG={}", sh_quote(&std::env::var("RUST_LOG").unwrap_or_else(|_| "info,russh=warn".into())));
    for var in ["CONSULS_SERVER_HOME", "CONSULS_SERVER_RUN", "CHM_TMUX_SOCKET"] {
        if let Ok(v) = std::env::var(var) {
            env.push_str(&format!(" {var}={}", sh_quote(&v)));
        }
    }
    let command = format!("umask 077; exec env -u TMUX -u TMUX_PANE {env} {} run 2>{}", sh_quote(&exe.to_string_lossy()), sh_quote(&log.to_string_lossy()));
    let started = std::process::Command::new(tmux()?)
        .args(["-L", &name, "-f", "/dev/null", "new-session", "-d", "-s", "server", "-x", "160", "-y", "50", &command])
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .status()?;
    anyhow::ensure!(started.success(), "tmux couldn't start it");
    let since = Instant::now();
    loop {
        if let Ok(status) = rt.block_on(ctl::request(&socket, &Request::Status))
            && (status["web"].is_string() || home.load_config()?.web.is_none())
        {
            println!("started\n{}", serde_json::to_string_pretty(&status)?);
            return Ok(());
        }
        if since.elapsed() > Duration::from_secs(30) {
            let tail = std::fs::read_to_string(&log).unwrap_or_default();
            let tail: Vec<&str> = tail.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect();
            anyhow::bail!("it didn't start within 30 s; its log ({}):\n{}", log.display(), tail.join("\n"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Stops it and waits until it's gone (its run folder and tmux server with it).
#[cfg(unix)]
fn stop() -> anyhow::Result<()> {
    use std::time::{Duration, Instant};

    use chm_daemon::ctl::{self, Request};
    use chm_daemon::rundir::RunDir;

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let dir = RunDir::default_path();
    let name = tmux_name();
    let tmux = tmux().ok();
    if rt.block_on(ctl::request(&dir.join("ctl.sock"), &Request::Stop)).is_err()
        && let Some(tmux) = &tmux
    {
        // Not answering: end its tmux server, if there's one (the server stops on the hangup).
        let _ = std::process::Command::new(tmux).args(["-L", &name, "kill-server"]).stderr(std::process::Stdio::null()).status();
    }
    let since = Instant::now();
    let tmux_up = || tmux.as_ref().is_some_and(|t| std::process::Command::new(t).args(["-L", &name, "has-session"]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success()));
    while dir.join("ctl.sock").exists() || tmux_up() {
        anyhow::ensure!(since.elapsed() < Duration::from_secs(15), "it didn't stop within 15 s");
        std::thread::sleep(Duration::from_millis(200));
    }
    println!("stopped");
    Ok(())
}

/// Stops it and removes what it keeps here. Says what stays: the files the desktop apps put on
/// this machine too, which the server only shares.
#[cfg(unix)]
fn uninstall() -> anyhow::Result<()> {
    use chm_daemon::home::Home;
    use chm_daemon::rundir::RunDir;

    stop()?;
    let home = Home::default_path();
    let run = RunDir::default_path();
    // SAFETY: getuid has no failure mode.
    let uid = unsafe { libc::getuid() };
    let tmux_socket = std::path::PathBuf::from(std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".into())).join(format!("tmux-{uid}")).join(tmux_name());
    for path in [&home, &run, &tmux_socket] {
        let removed = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        match removed {
            Ok(()) => println!("removed {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => println!("couldn't remove {}: {e}", path.display()),
        }
    }
    let here = chm_core::local::home();
    println!(
        "\nLeft in place, shared with the desktop apps that watch this machine:\n  {here}/.local/share/consuls (hook scripts)\n  \
         {here}/.local/state/consuls (hook events)\n  {here}/.cache/consuls/pastes (pasted images, removed after a week)\n  \
         the @chm_* options on tmux panes (names, labels, Notify)"
    );
    Ok(())
}
