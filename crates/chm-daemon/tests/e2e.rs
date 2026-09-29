//! End-to-end check of the notifier binary, on this machine, touching nothing real:
//!
//!   cargo test -p chm-daemon --test e2e -- --ignored --nocapture
//!
//! A private tmux server with one bare `sh` pane, scratch folders, delays of 2 s (needs input)
//! and 3 s (finished), and a fake push service that decrypts each push with a fixed phone key.
//! The notifier is configured over its control socket, the way the phone app will. Checks:
//! - an untracked pane never pushes; tracking goes to `@chm_notify` on the tmux pane;
//! - Stop → one push after the delay, readable only with the phone's key;
//! - Stop, then back to work / seen on a device (`@chm_seen`) / pane closed → no push;
//! - PermissionRequest → a push after the shorter delay, marked urgent;
//! - a push service saying 410 → that subscription is forgotten;
//! - only the owner gets in, and writes must be same-origin JSON;
//! - ctl: status, renew, export, stop — and stopping leaves no run folder;
//! - a notifier whose lease runs out stops by itself and leaves nothing;
//! - a second notifier in the same folder is refused.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, bail, ensure};
use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use chm_daemon::config::{DelayConfig, NotifierConfig, VapidConfig, WebConfig};
use chm_daemon::ctl::{self, Request};
use chm_daemon::http::DaemonState;
use chm_daemon::push::store::{Subscription, SubscriptionKeys};
use chm_daemon::push::vapid::Vapid;
use chm_daemon::push::webpush;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use p256::SecretKey;
use p256::elliptic_curve::Generate;

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

async fn fake_push(State(fake): State<Fake>, UrlPath(id): UrlPath<String>, headers: HeaderMap, body: Bytes) -> StatusCode {
    if id == "gone" {
        return StatusCode::GONE;
    }
    let text = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let Ok(plain) = webpush::decrypt(&fake.phone, &fake.auth, &body) else { return StatusCode::BAD_REQUEST };
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
    client: Client<HttpConnector, Full<Bytes>>,
    api: String,
    origin: String,
    tmux: String,
    events: PathBuf,
    got: Arc<Mutex<Vec<Received>>>,
}

impl Env {
    async fn call(&self, method: &str, path: &str, body: Option<serde_json::Value>, login: Option<&str>, origin: Option<&str>) -> (StatusCode, Vec<u8>) {
        let mut req = http::Request::builder().method(method).uri(format!("{}{path}", self.api));
        if let Some(l) = login {
            req = req.header("tailscale-user-login", l);
        }
        if body.is_some() {
            req = req.header("content-type", "application/json").header("origin", origin.unwrap_or(&self.origin));
        }
        let req = req.body(Full::new(Bytes::from(body.map(|b| b.to_string()).unwrap_or_default()))).unwrap();
        let res = self.client.request(req).await.unwrap();
        let status = res.status();
        (status, res.into_body().collect().await.unwrap().to_bytes().to_vec())
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

/// Starts the notifier binary with its run folder at `run`.
fn spawn_notifier(run: &Path, socket: &str, state: &Path) -> tokio::process::Child {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_consuls-notifier"))
        .arg("run")
        .env("CONSULS_NOTIFIER_DIR", run)
        .env("CHM_TMUX_SOCKET", socket)
        .env("XDG_STATE_HOME", state)
        .env("RUST_LOG", std::env::var("E2E_LOG").unwrap_or_else(|_| "warn".into()))
        .kill_on_drop(true)
        .spawn()
        .expect("the notifier binary")
}

async fn configure(run: &Path, config: NotifierConfig) -> anyhow::Result<()> {
    let socket = run.join("ctl.sock");
    let start = Instant::now();
    while !socket.exists() {
        ensure!(start.elapsed() < Duration::from_secs(10), "the control socket never appeared");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ctl::request(&socket, &Request::Configure { config: Box::new(config) }).await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs tmux; run with --ignored"]
async fn notifier_end_to_end() -> anyhow::Result<()> {
    let id = std::process::id();
    let socket = format!("chm-notifier-e2e-{id}");
    let base = std::env::temp_dir().join(format!("chm-notifier-e2e-{id}"));
    let state = base.join("state");
    std::fs::create_dir_all(&state)?;
    let tmux_bin = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("tmux");
    let tmux = format!("{tmux_bin} -L {socket}");
    let result = run(&base, &state, &socket, tmux.clone()).await;
    let _ = std::process::Command::new("sh").arg("-c").arg(format!("{tmux} kill-server 2>/dev/null; rm -f \"${{TMUX_TMPDIR:-/tmp}}/tmux-$(id -u)/{socket}\"")).status();
    let _ = std::fs::remove_dir_all(&base);
    result
}

async fn run(base: &Path, state: &Path, socket: &str, tmux: String) -> anyhow::Result<()> {
    // The fake push service.
    let fake = Fake { phone: Arc::new(SecretKey::generate()), auth: [9u8; 16], got: Arc::new(Mutex::new(Vec::new())) };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let push_addr = listener.local_addr()?;
    let app = Router::new().route("/push/{id}", post(fake_push)).with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    let p256dh = URL_SAFE_NO_PAD.encode(fake.phone.public_key().to_sec1_bytes());
    let auth = URL_SAFE_NO_PAD.encode(fake.auth);
    let sub = |id: &str| Subscription {
        endpoint: format!("http://{push_addr}/push/{id}"),
        keys: SubscriptionKeys { p256dh: p256dh.clone(), auth: auth.clone() },
        label: Some(id.into()),
        added: 0,
        last_ok: None,
    };

    // A private tmux server with one bare shell.
    ensure!(std::process::Command::new("sh").arg("-c").arg(format!("{tmux} new-session -d -s e2e -x 120 -y 30 /bin/sh")).status()?.success());

    let origin = "http://127.0.0.1:8787".to_string();
    let config = |lease_secs: Option<u64>, web: bool| NotifierConfig {
        vapid: VapidConfig { private_key: Vapid::generate_key(), subject: Some("https://e2e.example".into()) },
        subscriptions: vec![sub("phone"), sub("gone")],
        hosts: Vec::new(),
        self_name: Some("e2e-box".into()),
        delays: DelayConfig { needs_input_secs: 2, finished_secs: 3 },
        web: web.then(|| WebConfig { owner_logins: vec!["e2e".into()], public_origin: Some(origin.clone()), allow_origins: Vec::new(), tailscale_serve: false, https_port: 443, listen: None }),
        lease_days: 7,
        lease_secs,
        allow_insecure_endpoints: true,
    };

    // A notifier whose lease runs out stops by itself, leaving nothing.
    let short = base.join("short");
    let mut child = spawn_notifier(&short, socket, state);
    configure(&short, config(Some(2), false)).await?;
    let exited = tokio::time::timeout(Duration::from_secs(15), child.wait()).await.context("the lease didn't end it")??;
    ensure!(exited.success(), "exited with {exited}");
    ensure!(!short.exists(), "its run folder is still there");
    println!("ok   a lease that runs out stops it and leaves nothing");

    // The one under test.
    let run_dir = base.join("run");
    let mut child = spawn_notifier(&run_dir, socket, state);
    configure(&run_dir, config(None, true)).await?;
    let sock = run_dir.join("ctl.sock");
    // A second one in the same folder is refused.
    let second = tokio::process::Command::new(env!("CARGO_BIN_EXE_consuls-notifier")).arg("run").env("CONSULS_NOTIFIER_DIR", &run_dir).output().await?;
    ensure!(!second.status.success() && String::from_utf8_lossy(&second.stderr).contains("already running"), "a second notifier started");
    ensure!(run_dir.join("ctl.sock").exists(), "the refused one removed the first one's socket");
    println!("ok   a second notifier in the same folder is refused");

    let status = ctl::request(&sock, &Request::Status).await?;
    let api = status["web"].as_str().context("no web address in the status")?.to_string();
    ensure!(status["selfName"] == "e2e-box" && status["subscriptions"] == 2, "{status}");
    let renewed = ctl::request(&sock, &Request::Renew { days: Some(3) }).await?;
    ensure!(renewed["leaseUntil"].as_u64().is_some_and(|u| u >= unix() + 3 * 86_400 - 5), "{renewed}");
    println!("ok   ctl status and renew ({api})");

    let env = Env {
        client: Client::builder(TokioExecutor::new()).build_http(),
        api,
        origin,
        tmux,
        events: state.join("consuls/events.jsonl"),
        got: fake.got.clone(),
    };

    let mut pane = None;
    wait_for("the notifier sees the private tmux pane", Duration::from_secs(30), async || {
        pane = env.state().await.snapshot.panes.into_iter().find(|p| p.host == "@local" && p.tmux.is_some());
        pane.is_some()
    })
    .await?;
    let pane = pane.unwrap();
    let (key, pid) = (pane.key, pane.tmux.clone().unwrap().pane_id);

    // Who may use it.
    ensure!(env.call("GET", "/api/state", None, None, None).await.0 == StatusCode::FORBIDDEN, "no login: refused");
    ensure!(env.call("GET", "/api/state", None, Some("someone-else"), None).await.0 == StatusCode::FORBIDDEN, "wrong login: refused");
    let evil = env.call("POST", &format!("/api/panes/{key}/notify"), Some(serde_json::json!({ "mode": "delay" })), Some("e2e"), Some("https://evil.example")).await;
    ensure!(evil.0 == StatusCode::FORBIDDEN, "another origin can't change things");
    ensure!(env.call("GET", "/healthz", None, None, None).await.0 == StatusCode::OK);
    ensure!(env.call("GET", "/", None, Some("e2e"), None).await.0 == StatusCode::OK, "the web app is served");
    let bad = serde_json::json!({ "endpoint": "https://evil.example/push/x", "keys": { "p256dh": p256dh, "auth": auth }, "label": null });
    ensure!(env.call("POST", "/api/push/subscribe", Some(bad), Some("e2e"), None).await.0 == StatusCode::BAD_REQUEST, "only push services");
    println!("ok   only the owner gets in; writes are same-origin JSON; only push services");

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
    ensure!(claims["aud"] == format!("http://{push_addr}") && claims["sub"] == "https://e2e.example", "claims: {claims}");
    println!("     {after:?} after Stop: \"{}\" / \"{}\"", p.payload["title"], p.payload["body"]);
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

    // The pane closes before the delay: nothing.
    env.hook(&pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    env.hook(&pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(800)).await;
    env.sh(&format!("kill-pane -t {pid}"));
    tokio::time::sleep(Duration::from_secs(5)).await;
    ensure!(env.pushes().len() == 2, "pushed for a closed pane");
    println!("ok   pane closed before the delay: no push");

    // What whoever started it keeps: the configuration with the phones it has now.
    let export = ctl::request(&sock, &Request::Export).await?;
    ensure!(export["subscriptions"].as_array().map(Vec::len) == Some(1) && export["vapid"]["privateKey"].is_string(), "{export}");
    ctl::request(&sock, &Request::Stop).await?;
    let exited = tokio::time::timeout(Duration::from_secs(10), child.wait()).await.context("it didn't stop")??;
    ensure!(exited.success(), "exited with {exited}");
    ensure!(!run_dir.exists(), "its run folder is still there");
    println!("ok   ctl export and stop: nothing left behind");
    println!("all notifier checks passed");
    Ok(())
}
