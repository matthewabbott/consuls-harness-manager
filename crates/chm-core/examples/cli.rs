//! Headless driver for chm-core, handy for poking at real hosts without the UI.
//!
//!   cargo run -p chm-core --example cli -- tailscale
//!   cargo run -p chm-core --example cli -- exec <host> <user> '<script>'

use std::sync::Arc;
use std::time::Duration;

use chm_core::model::AuthMode;
use chm_core::ssh::hostkeys::KnownHosts;
use chm_core::ssh::{ConnectParams, SshConnection, SshNotice, exec};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,russh=warn".into()))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("tailscale") => {
            let status = chm_core::tailscale::fetch_status().await;
            println!("{}", serde_json::to_string_pretty(&status)?);
        }
        Some("exec") if args.len() >= 4 => {
            let (host, user, script) = (&args[1], &args[2], &args[3]);
            let conn = connect(host, user).await?;
            let out = exec::run(&conn, script, Duration::from_secs(60)).await?;
            print!("{}", out.stdout_str());
            eprint!("{}", out.stderr_str());
            println!("[exit {:?}]", out.status);
            conn.disconnect().await;
        }
        Some("watch") if args.len() >= 3 => watch(&args[1], &args[2]).await?,
        _ => eprintln!("usage: cli tailscale | cli exec <host> <user> '<script>' | cli watch <host> <user>"),
    }
    Ok(())
}

async fn connect(host: &str, user: &str) -> anyhow::Result<SshConnection> {
    let status = chm_core::tailscale::fetch_status().await;
    let peer = status.peers.iter().find(|p| p.id == host);
    let address = peer
        .and_then(|p| p.preferred_ip())
        .map(str::to_string)
        .unwrap_or_else(|| host.to_string());
    let params = ConnectParams {
        host_id: host.to_string(),
        address,
        port: 22,
        user: user.to_string(),
        auth: AuthMode::Auto,
        pinned_keys: peer.map(|p| p.ssh_host_keys.clone()).unwrap_or_default(),
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(n) = rx.recv().await {
            match n {
                SshNotice::TailscaleCheck { url } => eprintln!(">>> Tailscale SSH check: open {url}"),
                other => eprintln!(">>> {other:?}"),
            }
        }
    });
    let started = std::time::Instant::now();
    let conn = SshConnection::connect(&params, Arc::new(KnownHosts::in_memory()), tx).await?;
    eprintln!(">>> connected to {} ({}) in {:?}", host, params.address, started.elapsed());
    Ok(conn)
}

/// Runs the full Core against one host for a few seconds and prints what the UI would get.
async fn watch(host: &str, user: &str) -> anyhow::Result<()> {
    use chm_core::model::{CoreEvent, HostConfig};
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct Printer {
        tiles: Mutex<HashMap<u32, (usize, Vec<u8>)>>,
    }
    impl chm_core::Sink for Printer {
        fn event(&self, event: CoreEvent) {
            match &event {
                CoreEvent::Panes { host, panes } => {
                    println!("[panes] {host}: {} panes", panes.len());
                    for p in panes {
                        println!(
                            "   key={} {} {}:{} '{}' cmd={} harness={:?} {}x{} title={:?}",
                            p.key, p.pane_id, p.session_name, p.window_index, p.window_name, p.current_command,
                            p.harness, p.width, p.height, p.title
                        );
                    }
                }
                CoreEvent::Tailnet { .. } => println!("[tailnet] updated"),
                other => println!("[event] {}", serde_json::to_string(other).unwrap()),
            }
        }
        fn frame(&self, frame: Vec<u8>) {
            let key = u32::from_le_bytes(frame[1..5].try_into().unwrap());
            let mut tiles = self.tiles.lock().unwrap();
            let e = tiles.entry(key).or_default();
            e.0 += 1;
            e.1 = frame[9..].to_vec();
        }
    }

    let dir = std::env::temp_dir().join(format!("chm-watch-{}", std::process::id()));
    let printer = Arc::new(Printer { tiles: Mutex::new(HashMap::new()) });
    let core = chm_core::Core::new(dir.clone(), printer.clone());
    core.start();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    core.upsert_host(HostConfig::new(host, user));
    tokio::time::sleep(Duration::from_secs(8)).await;
    for (key, (count, snap)) in printer.tiles.lock().unwrap().iter() {
        println!("=== tile {key}: {count} frames, last snapshot as text:");
        print!("{}", snapshot_text(snap));
    }
    core.disconnect(host);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn snapshot_text(s: &[u8]) -> String {
    let u16_at = |i: usize| u16::from_le_bytes([s[i], s[i + 1]]) as usize;
    let rows = u16_at(2);
    let mut pos = 9;
    let mut out = String::new();
    for _ in 0..rows {
        let runs = u16_at(pos);
        pos += 2;
        let mut line = String::new();
        for _ in 0..runs {
            let start = u16_at(pos);
            let len = u16_at(pos + 14);
            let text = String::from_utf8_lossy(&s[pos + 16..pos + 16 + len]).into_owned();
            pos += 16 + len;
            while line.chars().count() < start {
                line.push(' ');
            }
            line.push_str(&text);
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}
