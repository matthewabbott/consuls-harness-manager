//! End-to-end check of the push daemon, on this machine, touching nothing real:
//!
//!   cargo run -p chm-daemon --example e2e
//!
//! A private tmux server with one bare `sh` pane, a scratch data folder and events file, delays
//! of 2 s (needs input) and 3 s (finished), and a fake push service that checks each push's
//! VAPID token and decrypts it with a fixed phone key. Hook events are appended to the events
//! file the way the hook script writes them. Checks:
//! - an untracked pane never pushes; tracking goes to `@chm_notify` on the tmux pane;
//! - Stop → one push after the delay, readable only with the phone's key;
//! - Stop, then back to work / seen on a device (`@chm_seen`) / pane closed → no push;
//! - PermissionRequest → a push after the shorter delay, marked urgent;
//! - a push service saying 410 → that subscription is forgotten;
//! - only the owner gets in, and writes must be same-origin JSON.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, bail, ensure};
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chm_daemon::http::DaemonState;
use chm_daemon::push::webpush;
use p256::SecretKey;
use p256::elliptic_curve::Generate;
use tower::ServiceExt;

/// A push the fake service received, decrypted.
#[derive(Debug, Clone)]
struct Received {
    path: String,
    at: Instant,
    urgency: String,
    authorization: String,
    payload: serde_json::Value,
}

#[derive(Clone)]
struct Fake {
    phone: Arc<SecretKey>,
    auth: [u8; 16],
    got: Arc<Mutex<Vec<Received>>>,
}

async fn fake_push(State(fake): State<Fake>, Path(id): Path<String>, headers: HeaderMap, body: axum::body::Bytes) -> StatusCode {
    if id == "gone" {
        return StatusCode::GONE;
    }
    let text = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let plain = match webpush::decrypt(&fake.phone, &fake.auth, &body) {
        Ok(p) => p,
        Err(e) => {
            println!("     fake push service: couldn't decrypt: {e}");
            return StatusCode::BAD_REQUEST;
        }
    };
    fake.got.lock().unwrap().push(Received {
        path: id,
        at: Instant::now(),
        urgency: text("urgency"),
        authorization: text("authorization"),
        payload: serde_json::from_slice(&plain).unwrap_or_default(),
    });
    StatusCode::CREATED
}

struct Env {
    router: Router,
    tmux: String,
    events: std::path::PathBuf,
    got: Arc<Mutex<Vec<Received>>>,
    origin: String,
}

impl Env {
    async fn call(&self, method: &str, path: &str, body: Option<serde_json::Value>, login: Option<&str>, origin: Option<&str>) -> (StatusCode, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(l) = login {
            req = req.header("tailscale-user-login", l);
        }
        if body.is_some() {
            req = req.header("content-type", "application/json").header("origin", origin.unwrap_or(&self.origin));
        }
        let req = req.body(body.map(|b| Body::from(b.to_string())).unwrap_or_default()).unwrap();
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        (status, to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec())
    }

    async fn state(&self) -> DaemonState {
        let (status, body) = self.call("GET", "/api/state", None, Some("e2e"), None).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        serde_json::from_slice(&body).unwrap()
    }

    fn sh(&self, args: &str) -> String {
        let out = std::process::Command::new("sh").arg("-c").arg(format!("{} {args}", self.tmux)).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn hook(&self, pane: &str, event: &str, ts: u64) {
        use std::io::Write;
        let line = format!(r#"{{"v":1,"ts":{ts},"pane":"{pane}","harness":"claude","event":"{event}","detail":"","session":"","transcript":""}}"#);
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&self.events).unwrap();
        writeln!(f, "{line}").unwrap();
    }

    fn pushes(&self) -> Vec<Received> {
        self.got.lock().unwrap().clone()
    }
}

fn unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

async fn wait_for(what: &str, timeout: Duration, mut check: impl AsyncFnMut() -> bool) -> anyhow::Result<()> {
    let start = Instant::now();
    while !check().await {
        if start.elapsed() > timeout {
            bail!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("ok   {what} ({:?})", start.elapsed());
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let id = std::process::id();
    let socket = format!("chm-daemon-e2e-{id}");
    let dir = std::env::temp_dir().join(format!("chm-daemon-e2e-{id}"));
    let state = dir.join("state");
    std::fs::create_dir_all(&state)?;
    // SAFETY: before any other thread reads the environment.
    unsafe {
        std::env::set_var("CHM_TMUX_SOCKET", &socket);
        std::env::set_var("XDG_STATE_HOME", &state);
    }
    let tmux = std::env::var("TMUX_BIN").unwrap_or_else(|_| ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].into_iter().find(|p| std::path::Path::new(p).exists()).unwrap_or("tmux").to_string());
    let tmux = format!("{tmux} -L {socket}");
    let result = run(&dir, &state, tmux.clone()).await;
    let _ = std::process::Command::new("sh").arg("-c").arg(format!("{tmux} kill-server 2>/dev/null; rm -f \"${{TMUX_TMPDIR:-/tmp}}/tmux-$(id -u)/{socket}\"")).status();
    let _ = std::fs::remove_dir_all(&dir);
    result?;
    println!("all push daemon checks passed");
    Ok(())
}

async fn run(dir: &std::path::Path, state: &std::path::Path, tmux: String) -> anyhow::Result<()> {
    // The fake push service.
    let fake = Fake { phone: Arc::new(SecretKey::generate()), auth: [9u8; 16], got: Arc::new(Mutex::new(Vec::new())) };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let push_addr = listener.local_addr()?;
    let app = Router::new().route("/push/{id}", post(fake_push)).with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });

    let origin = "http://127.0.0.1:8787".to_string();
    let data = dir.join("data");
    std::fs::create_dir_all(&data)?;
    std::fs::write(
        data.join("daemon.json"),
        serde_json::json!({ "ownerLogins": ["e2e"], "publicOrigin": origin, "needsInputSecs": 2, "finishedSecs": 3, "allowInsecureEndpoints": true }).to_string(),
    )?;

    // A private tmux server with one bare shell, before the daemon looks.
    let status = std::process::Command::new("sh").arg("-c").arg(format!("{tmux} new-session -d -s e2e -x 120 -y 30 /bin/sh")).status()?;
    ensure!(status.success(), "couldn't start the private tmux server");

    let daemon = chm_daemon::start(data.clone()).await?;
    let env = Env { router: chm_daemon::http::router(daemon), tmux, events: state.join("consuls/events.jsonl"), got: fake.got.clone(), origin };

    // The pane shows up under @local.
    let mut pane = None;
    wait_for("the daemon sees the private tmux pane", Duration::from_secs(30), async || {
        pane = env.state().await.snapshot.panes.into_iter().find(|p| p.host == "@local" && p.tmux.is_some());
        pane.is_some()
    })
    .await?;
    let pane = pane.unwrap();
    let (key, pid) = (pane.key, pane.tmux.clone().unwrap().pane_id);
    println!("     pane {pid} (key {key})");

    // Who may use it.
    ensure!(env.call("GET", "/api/state", None, None, None).await.0 == StatusCode::FORBIDDEN, "no login: refused");
    ensure!(env.call("GET", "/api/state", None, Some("someone-else"), None).await.0 == StatusCode::FORBIDDEN, "wrong login: refused");
    let evil = env.call("POST", &format!("/api/panes/{key}/notify"), Some(serde_json::json!({ "mode": "delay" })), Some("e2e"), Some("https://evil.example")).await;
    ensure!(evil.0 == StatusCode::FORBIDDEN, "another origin can't change things");
    ensure!(env.call("GET", "/healthz", None, None, None).await.0 == StatusCode::OK);
    ensure!(env.call("GET", "/", None, Some("e2e"), None).await.0 == StatusCode::OK, "the web app is served");
    println!("ok   only the owner gets in; writes are same-origin JSON");

    // The phone subscribes (and a second device whose subscription is dead).
    let p256dh = URL_SAFE_NO_PAD.encode(fake.phone.public_key().to_sec1_bytes());
    let auth = URL_SAFE_NO_PAD.encode(fake.auth);
    for id in ["phone", "gone"] {
        let sub = serde_json::json!({ "endpoint": format!("http://{push_addr}/push/{id}"), "keys": { "p256dh": p256dh, "auth": auth }, "label": id });
        let (st, body) = env.call("POST", "/api/push/subscribe", Some(sub), Some("e2e"), None).await;
        ensure!(st == StatusCode::NO_CONTENT, "subscribe: {st} {}", String::from_utf8_lossy(&body));
    }
    let bad = serde_json::json!({ "endpoint": "https://evil.example/push/x", "keys": { "p256dh": p256dh, "auth": auth }, "label": null });
    ensure!(env.call("POST", "/api/push/subscribe", Some(bad), Some("e2e"), None).await.0 == StatusCode::BAD_REQUEST, "only push services");
    ensure!(env.state().await.subscriptions.len() == 2);
    println!("ok   subscribed (and a non-push-service endpoint refused)");

    let mut ts = unix();
    let mut next = || {
        ts += 2;
        ts
    };

    // Untracked: nothing.
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    env.hook(&pid, "Stop", next());
    tokio::time::sleep(Duration::from_secs(4)).await;
    ensure!(env.pushes().is_empty(), "an untracked pane pushed: {:?}", env.pushes());
    println!("ok   untracked: no push");

    // Track it: kept on the tmux pane.
    let (st, _) = env.call("POST", &format!("/api/panes/{key}/notify"), Some(serde_json::json!({ "mode": "delay" })), Some("e2e"), None).await;
    ensure!(st == StatusCode::NO_CONTENT, "notify: {st}");
    ensure!(env.sh(&format!("show-options -pqv -t {pid} @chm_notify")) == "delay", "@chm_notify not on the tmux pane");
    wait_for("tracked in the snapshot", Duration::from_secs(5), async || env.state().await.snapshot.panes.iter().any(|p| p.key == key && p.notify.is_some())).await?;

    // Finished → one push after ~3 s, readable only by the phone. (The dead one gets forgotten.)
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    let stopped = Instant::now();
    env.hook(&pid, "Stop", next());
    wait_for("a push after the delay", Duration::from_secs(10), async || !env.pushes().is_empty()).await?;
    let p = env.pushes()[0].clone();
    let after = p.at.duration_since(stopped);
    ensure!(after >= Duration::from_millis(2500), "pushed too early ({after:?})");
    ensure!(p.path == "phone");
    ensure!(p.payload["title"].as_str().is_some_and(|t| t.ends_with("is done")), "title: {}", p.payload);
    ensure!(p.payload["url"].as_str().is_some_and(|u| u.starts_with("/#pane=") && u.ends_with(&pid.replace('%', "%25"))), "url: {}", p.payload);
    ensure!(p.urgency == "normal");
    let token = p.authorization.strip_prefix("vapid t=").and_then(|v| v.split(", k=").next()).context("vapid header")?;
    let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').nth(1).unwrap())?)?;
    ensure!(claims["aud"] == format!("http://{push_addr}"), "aud: {claims}");
    println!("     {:?} after Stop: \"{}\" / \"{}\"", after, p.payload["title"], p.payload["body"]);
    wait_for("the dead subscription forgotten (410)", Duration::from_secs(10), async || env.state().await.subscriptions.len() == 1).await?;
    tokio::time::sleep(Duration::from_secs(4)).await;
    ensure!(env.pushes().len() == 1, "one push per turn: {:?}", env.pushes());

    // Back to work before the delay: nothing.
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    env.hook(&pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(1200)).await;
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_secs(4)).await;
    ensure!(env.pushes().len() == 1, "pushed although the agent went back to work");
    println!("ok   back to work before the delay: no push");

    // Seen on a device (another app wrote @chm_seen): nothing.
    env.hook(&pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(800)).await;
    env.sh(&format!("set-option -p -t {pid} @chm_seen {}", unix()));
    tokio::time::sleep(Duration::from_secs(5)).await;
    ensure!(env.pushes().len() == 1, "pushed although the pane was seen");
    println!("ok   seen on a device: no push");

    // Needs input → urgent push after ~2 s.
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    let asked = Instant::now();
    env.hook(&pid, "PermissionRequest", next());
    wait_for("a needs-input push", Duration::from_secs(10), async || env.pushes().len() == 2).await?;
    let p = env.pushes()[1].clone();
    let after = p.at.duration_since(asked);
    ensure!(after >= Duration::from_millis(1500) && after < Duration::from_millis(3500), "needs input pushed after {after:?}");
    ensure!(p.urgency == "high" && p.payload["title"].as_str().is_some_and(|t| t.ends_with("needs you")), "{p:?}");
    println!("ok   needs input: urgent push after {after:?}");

    // The pane closes before the delay: nothing (and it's the last pane: the server goes too).
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    env.hook(&pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(800)).await;
    env.sh(&format!("kill-pane -t {pid}"));
    tokio::time::sleep(Duration::from_secs(5)).await;
    ensure!(env.pushes().len() == 2, "pushed for a closed pane");
    println!("ok   pane closed before the delay: no push");
    Ok(())
}
