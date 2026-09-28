//! Live tests against a real host. They only ever touch a private tmux socket
//! (`tmux -L chm-test-…`), never the user's sessions.
//!
//!   CHM_E2E_HOST=spark2 CHM_E2E_USER=consulear cargo test -p chm-core --test live -- --ignored --nocapture

use std::sync::Arc;
use std::time::Duration;

use chm_core::link::Link;
use chm_core::model::AuthMode;
use chm_core::ssh::hostkeys::KnownHosts;
use chm_core::ssh::{ConnectParams, SshConnection, exec};
use chm_core::term::TileTerm;
use chm_core::tmux::quote::{cmd, quote};
use chm_core::tmux::seed::{parse_seed, seed_command};
use chm_core::tmux::{ClientEvent, ControlClient, Event, TmuxServer};

async fn connect() -> Arc<SshConnection> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "chm_core=debug,russh=info".into()))
        .with_test_writer()
        .try_init();
    let host = std::env::var("CHM_E2E_HOST").expect("set CHM_E2E_HOST");
    let user = std::env::var("CHM_E2E_USER").unwrap_or_else(|_| "consulear".into());
    let status = chm_core::tailscale::fetch_status().await;
    let peer = status.peers.iter().find(|p| p.id == host).expect("host not on tailnet");
    let params = ConnectParams {
        host_id: host.clone(),
        address: peer.preferred_ip().unwrap().to_string(),
        port: 22,
        user,
        auth: AuthMode::Auto,
        pinned_keys: peer.ssh_host_keys.clone(),
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    Arc::new(SshConnection::connect(&params, Arc::new(KnownHosts::in_memory()), tx).await.expect("connect"))
}

struct Scratch {
    server: TmuxServer,
}

impl Scratch {
    async fn new(conn: &SshConnection, cols: u16, rows: u16) -> Self {
        let name = format!("chm-test-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let server = TmuxServer { socket_name: Some(name), bin: None };
        let out = exec::run(
            conn,
            &format!("{} new-session -d -s t -x {cols} -y {rows} 'bash --norc --noprofile'", server.prefix()),
            Duration::from_secs(20),
        )
        .await
        .unwrap();
        eprintln!("[scratch] new-session status={:?}", out.status);
        assert!(out.success(), "new-session failed: {}", out.stderr_str());
        Self { server }
    }

    async fn kill(&self, conn: &SshConnection) {
        let _ = exec::run(conn, &format!("{} kill-server", self.server.prefix()), Duration::from_secs(10)).await;
    }
}

/// Seeding while the pane is busy must neither drop nor duplicate output.
#[tokio::test]
#[ignore]
async fn seed_is_exact_under_load() {
    let conn = connect().await;
    let scratch = Scratch::new(&conn, 60, 12).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = ControlClient::attach(&Link::Ssh(conn.clone()), &scratch.server, "t", 0, tx).await.expect("attach");
    eprintln!("[test] attached {}", client.session_id);
    let panes = client.command("list-panes -F '#{pane_id}'").await.unwrap().text();
    let pane: u32 = panes.trim().trim_start_matches('%').parse().unwrap();

    let mut term = TileTerm::new(60, 12);
    // Initial seed.
    let (seed_cmd, n) = seed_command(pane, 0);
    client.send_tagged(&seed_cmd, n, 1).await.unwrap();
    // Start a noisy loop, then re-seed repeatedly while it runs.
    let script = "i=0; while [ $i -lt 600 ]; do echo \"line $i $(printf '%*s' $((i % 40)) '' | tr ' ' x)\"; i=$((i+1)); done; echo DONE";
    client.command(&cmd(&["send-keys", "-t", &format!("%{pane}"), "-l", script])).await.unwrap();
    client.command(&format!("send-keys -t '%{pane}' Enter")).await.unwrap();

    let mut seeding = true;
    let mut seeds = 1u64;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut done = false;
    while tokio::time::Instant::now() < deadline {
        let Ok(Some((_, ev))) = tokio::time::timeout(Duration::from_millis(300), rx.recv()).await else {
            if done {
                break;
            }
            continue;
        };
        match ev {
            ClientEvent::Tmux(Event::Output { pane: p, data }) if p == pane => {
                if !seeding {
                    term.feed(&data);
                    if String::from_utf8_lossy(&data).contains("DONE") {
                        done = true;
                    }
                }
            }
            ClientEvent::Tagged { replies, tag } => {
                eprintln!("[seed {tag}] {} replies, ok={:?}", replies.len(), replies.iter().map(|r| r.ok).collect::<Vec<_>>());
                let seed = parse_seed(&replies, false).expect("seed parses");
                term.feed(&seed.to_terminal_bytes());
                seeding = false;
                if seeds < 8 {
                    seeds += 1;
                    seeding = true;
                    let (seed_cmd, n) = seed_command(pane, 0);
                    client.send_tagged(&seed_cmd, n, seeds).await.unwrap();
                }
            }
            ClientEvent::Tmux(Event::Pause { .. }) => panic!("unexpected pause"),
            other => eprintln!("[event] {other:?}"),
        }
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    while let Ok((_, ev)) = rx.try_recv() {
        if let ClientEvent::Tmux(Event::Output { pane: p, data }) = ev
            && p == pane
        {
            term.feed(&data);
        }
    }

    let truth = client.command(&format!("capture-pane -p -t '%{pane}'")).await.unwrap();
    let truth: String = truth.lines.iter().map(|l| format!("{}\n", String::from_utf8_lossy(l).trim_end())).collect();
    println!("--- ours\n{}--- tmux\n{}", term.text(), truth);
    assert_eq!(term.text(), truth, "tile terminal diverged from tmux after {seeds} seeds");
    scratch.kill(&conn).await;
}

/// Text with every awkward character survives `set-buffer` quoting byte-for-byte.
#[tokio::test]
#[ignore]
async fn set_buffer_roundtrip() {
    let conn = connect().await;
    let scratch = Scratch::new(&conn, 80, 24).await;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = ControlClient::attach(&Link::Ssh(conn.clone()), &scratch.server, "t", 0, tx).await.unwrap();
    let samples = [
        "plain",
        "quotes ' and \" and `backticks`",
        "$HOME ${USER} $(whoami) ~/path ~user",
        "semi;colon {braces} #{pane_id} # comment",
        "back\\slash \\n literal \\033",
        "multi\nline\n\ttabbed\r\nCRLF",
        "emoji 🎉 日本語 é",
        "ctrl \u{1} \u{1b}[31m",
    ];
    for s in samples {
        client.command(&format!("set-buffer -b chmtest -- {}", quote(s))).await.unwrap();
        let got = client.command("show-buffer -b chmtest").await.unwrap();
        // show-buffer output is split into lines by the reply framing.
        let got = got.lines.iter().map(|l| String::from_utf8_lossy(l).into_owned()).collect::<Vec<_>>().join("\n");
        assert_eq!(got, s, "roundtrip failed for {s:?}");
    }
    scratch.kill(&conn).await;
}
