//! End-to-end check of the server binary, on this machine, touching nothing real:
//!
//!   cargo test -p chm-daemon --test e2e -- --ignored --nocapture
//!
//! A private tmux server with one bare `sh` pane, a scratch install folder, delays of 2 s (needs
//! input) and 3 s (finished), and a fake push service that decrypts each push with a fixed phone
//! key. The web app's side is a real WebSocket client. Checks:
//! - pushes: an untracked pane never pushes; Stop → one push after the delay, readable only with
//!   the phone's key; back to work / seen on a device / pane closed → none; PermissionRequest → an
//!   urgent push after the shorter delay; a push service saying 410 → that phone is forgotten;
//! - who gets in: only the owner, writes only same-origin JSON, the WebSocket only from the web
//!   app's origin;
//! - the WebSocket: hello, calls, a pane's live output, typing into it, a second device taking
//!   over, and a client that goes away no longer counting as looking at a pane (pushes resume);
//! - what lasts: phones and machines survive a restart; `uninstall` leaves nothing;
//! - a server whose lease runs out stops by itself, keeping its install folder; a second server
//!   in the same run folder is refused.
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
use chm_daemon::config::{ServerConfig, VapidConfig, WebConfig};
use chm_daemon::ctl::{self, Request};
use chm_daemon::http::DaemonState;
use chm_daemon::push::store::{Subscription, SubscriptionKeys};
use chm_daemon::push::vapid::Vapid;
use chm_daemon::push::webpush;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use p256::SecretKey;
use p256::elliptic_curve::Generate;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[derive(Debug, Clone)]
struct Received {
    path: String,
    at: Instant,
    urgency: String,
    authorization: String,
    payload: Value,
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

/// The scratch folders and the private tmux server one run uses.
struct Scratch {
    base: PathBuf,
    socket: String,
    tmux: String,
}

impl Scratch {
    fn home(&self) -> PathBuf {
        self.base.join("home")
    }
    fn run_dir(&self) -> PathBuf {
        self.base.join("run")
    }
    fn state(&self) -> PathBuf {
        self.base.join("state")
    }
    fn command(&self, verb: &str) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_consuls-server"));
        cmd.arg(verb)
            .env("CONSULS_SERVER_HOME", self.home())
            .env("CONSULS_SERVER_RUN", self.run_dir())
            .env("CHM_TMUX_SOCKET", &self.socket)
            .env("CONSULS_SERVER_TMUX", format!("{}-srv", self.socket))
            .env("XDG_STATE_HOME", self.state())
            .env("RUST_LOG", std::env::var("E2E_LOG").unwrap_or_else(|_| "warn".into()))
            .kill_on_drop(true);
        cmd
    }
    fn install(&self, config: &ServerConfig) -> anyhow::Result<()> {
        std::fs::create_dir_all(self.home().join("core"))?;
        std::fs::write(self.home().join("config.json"), serde_json::to_vec_pretty(config)?)?;
        // Short push delays, as if set from the app.
        let core = self.home().join("core/config.json");
        if !core.exists() {
            std::fs::write(core, r#"{"notify":{"needsInputSecs":2,"finishedSecs":3}}"#)?;
        }
        Ok(())
    }
    /// Starts `run` and waits until it serves; returns the API's address.
    async fn run(&self) -> anyhow::Result<(tokio::process::Child, String)> {
        let child = self.command("run").spawn()?;
        let socket = self.run_dir().join("ctl.sock");
        let start = Instant::now();
        loop {
            if let Ok(status) = ctl::request(&socket, &Request::Status).await
                && let Some(web) = status["web"].as_str()
            {
                return Ok((child, web.trim_start_matches("http://").to_string()));
            }
            ensure!(start.elapsed() < Duration::from_secs(15), "it didn't start");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    fn sh(&self, args: &str) -> String {
        let out = std::process::Command::new("sh").arg("-c").arg(format!("{} {args}", self.tmux)).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

struct Api {
    client: Client<HttpConnector, Full<Bytes>>,
    addr: String,
    origin: String,
}

impl Api {
    async fn call(&self, method: &str, path: &str, body: Option<Value>, login: Option<&str>, origin: Option<&str>) -> (StatusCode, Vec<u8>) {
        let mut req = http::Request::builder().method(method).uri(format!("http://{}{path}", self.addr));
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
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The web app's side of `/api/ws`.
struct Ws {
    socket: Socket,
    next: u64,
    /// Pane output seen so far (RAW and RESET payloads, by pane key).
    output: Vec<(u32, u8, Vec<u8>)>,
    texts: Vec<Value>,
}

async fn open_ws(addr: &str, origin: Option<&str>, login: Option<&str>) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = format!("ws://{addr}/api/ws").into_client_request()?;
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    if let Some(l) = login {
        req.headers_mut().insert("tailscale-user-login", l.parse().unwrap());
    }
    let (socket, _) = tokio_tungstenite::connect_async(req).await?;
    Ok(Ws { socket, next: 1, output: Vec::new(), texts: Vec::new() })
}

impl Ws {
    /// Reads one message: texts are kept, frames split into pane output.
    async fn read(&mut self, timeout: Duration) -> anyhow::Result<Option<Value>> {
        let msg = match tokio::time::timeout(timeout, self.socket.next()).await {
            Err(_) => return Ok(None),
            Ok(None) => bail!("the socket closed"),
            Ok(Some(m)) => m?,
        };
        match msg {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t)?;
                self.texts.push(v.clone());
                Ok(Some(v))
            }
            Message::Binary(b) => {
                let mut pos = 0;
                while pos + 9 <= b.len() {
                    let kind = b[pos];
                    let key = u32::from_le_bytes(b[pos + 1..pos + 5].try_into().unwrap());
                    let len = u32::from_le_bytes(b[pos + 5..pos + 9].try_into().unwrap()) as usize;
                    self.output.push((key, kind, b[pos + 9..pos + 9 + len].to_vec()));
                    pos += 9 + len;
                }
                Ok(Some(Value::Null))
            }
            Message::Close(_) => bail!("the socket closed"),
            _ => Ok(Some(Value::Null)),
        }
    }

    async fn wait_for(&mut self, what: &str, timeout: Duration, mut done: impl FnMut(&Ws) -> bool) -> anyhow::Result<()> {
        let start = Instant::now();
        while !done(self) {
            ensure!(start.elapsed() < timeout, "timed out waiting for {what}");
            self.read(Duration::from_millis(200)).await?;
        }
        Ok(())
    }

    async fn call(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next;
        self.next += 1;
        self.socket.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string().into())).await?;
        self.wait_for(&format!("the reply to {method}"), Duration::from_secs(10), |w| w.texts.iter().any(|t| t["type"] == "reply" && t["id"] == id)).await?;
        let reply = self.texts.iter().find(|t| t["type"] == "reply" && t["id"] == id).unwrap().clone();
        match reply.get("error") {
            Some(e) => bail!("{method}: {e}"),
            None => Ok(reply["ok"].clone()),
        }
    }

    fn saw(&self, key: u32, text: &str) -> bool {
        self.output.iter().any(|(k, kind, bytes)| *k == key && (*kind == 2 || *kind == 3) && String::from_utf8_lossy(bytes).contains(text))
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

fn hook(events: &Path, pane: &str, event: &str, ts: u64) {
    use std::io::Write;
    let line = format!(r#"{{"v":1,"ts":{ts},"pane":"{pane}","harness":"claude","event":"{event}","detail":"","session":"","transcript":""}}"#);
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(events).unwrap();
    writeln!(f, "{line}").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs tmux; run with --ignored"]
async fn server_end_to_end() -> anyhow::Result<()> {
    let id = std::process::id();
    let socket = format!("chm-server-e2e-{id}");
    let base = std::env::temp_dir().join(format!("chm-server-e2e-{id}"));
    let tmux_bin = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("tmux");
    let tmux = format!("{tmux_bin} -L {socket}");
    let scratch = Scratch { base: base.clone(), socket: socket.clone(), tmux: tmux.clone() };
    std::fs::create_dir_all(scratch.state())?;
    let result = run(&scratch).await;
    let _ = std::process::Command::new("sh").arg("-c").arg(format!("{tmux} kill-server 2>/dev/null; rm -f \"${{TMUX_TMPDIR:-/tmp}}/tmux-$(id -u)/{socket}\"")).status();
    let _ = std::fs::remove_dir_all(&base);
    result
}

async fn run(scratch: &Scratch) -> anyhow::Result<()> {
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
    let pushes = || fake.got.lock().unwrap().clone();

    // A private tmux server with one bare shell.
    ensure!(std::process::Command::new("sh").arg("-c").arg(format!("{} new-session -d -s e2e -x 120 -y 30 /bin/sh", scratch.tmux)).status()?.success());

    let origin = "http://127.0.0.1:8787".to_string();
    let config = |lease_secs: Option<u64>| ServerConfig {
        vapid: VapidConfig { private_key: Vapid::generate_key(), subject: Some("https://e2e.example".into()) },
        subscriptions: vec![sub("phone"), sub("gone")],
        hosts: Vec::new(),
        self_name: Some("e2e-box".into()),
        web: Some(WebConfig {
            owner_logins: vec!["e2e".into()],
            public_origin: Some(origin.clone()),
            allow_origins: Vec::new(),
            tailscale_serve: false,
            https_port: 443,
            listen: Some("127.0.0.1:0".into()),
        }),
        lease_days: 7,
        lease_secs,
        allow_insecure_endpoints: true,
    };

    // A server whose lease runs out stops by itself, keeping its install folder.
    scratch.install(&config(Some(2)))?;
    let (mut child, _) = scratch.run().await?;
    let exited = tokio::time::timeout(Duration::from_secs(15), child.wait()).await.context("the lease didn't end it")??;
    ensure!(exited.success(), "exited with {exited}");
    ensure!(!scratch.run_dir().exists(), "its run folder is still there");
    ensure!(scratch.home().join("config.json").exists(), "its install folder went too");
    println!("ok   a lease that runs out stops it; its install folder stays");

    // The one under test.
    scratch.install(&config(None))?;
    let _ = std::fs::remove_file(scratch.home().join("subscriptions.json"));
    let (mut child, addr) = scratch.run().await?;
    let second = scratch.command("run").output().await?;
    ensure!(!second.status.success() && String::from_utf8_lossy(&second.stderr).contains("already running"), "a second server started");
    println!("ok   a second server in the same run folder is refused");
    let sock = scratch.run_dir().join("ctl.sock");
    let renewed = ctl::request(&sock, &Request::Renew { days: Some(3) }).await?;
    ensure!(renewed["leaseUntil"].as_u64().is_some_and(|u| u >= unix() + 3 * 86_400 - 5), "{renewed}");

    let api = Api { client: Client::builder(TokioExecutor::new()).build_http(), addr: addr.clone(), origin: origin.clone() };
    let events = scratch.state().join("consuls/events.jsonl");
    let mut pane = None;
    wait_for("the server sees the private tmux pane", Duration::from_secs(30), async || {
        pane = api.state().await.snapshot.panes.into_iter().find(|p| p.host == "@local" && p.tmux.is_some());
        pane.is_some()
    })
    .await?;
    let pane = pane.unwrap();
    let (key, pid) = (pane.key, pane.tmux.clone().unwrap().pane_id);

    // Who may use it.
    ensure!(api.call("GET", "/api/state", None, None, None).await.0 == StatusCode::FORBIDDEN, "no login: refused");
    ensure!(api.call("GET", "/api/state", None, Some("someone-else"), None).await.0 == StatusCode::FORBIDDEN, "wrong login: refused");
    let evil = api.call("POST", &format!("/api/panes/{key}/notify"), Some(json!({ "mode": "delay" })), Some("e2e"), Some("https://evil.example")).await;
    ensure!(evil.0 == StatusCode::FORBIDDEN, "another origin can't change things");
    ensure!(api.call("GET", "/healthz", None, None, None).await.0 == StatusCode::OK);
    let (page_status, _) = api.call("GET", "/", None, Some("e2e"), None).await;
    ensure!(page_status == StatusCode::OK, "the web app is served");
    for (o, l, why) in [(Some("https://evil.example"), Some("e2e"), "another origin"), (None, Some("e2e"), "no origin"), (Some(origin.as_str()), None, "no login")] {
        match open_ws(&addr, o, l).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) if res.status() == StatusCode::FORBIDDEN => {}
            other => bail!("a WebSocket with {why} wasn't refused: {:?}", other.map(|_| ())),
        }
    }
    println!("ok   only the owner gets in; writes and the WebSocket only from the web app's origin");

    // The web app's connection: hello, calls, a pane's output, typing.
    let mut ws = open_ws(&addr, Some(&origin), Some("e2e")).await?;
    ws.wait_for("the hello", Duration::from_secs(5), |w| w.texts.iter().any(|t| t["type"] == "hello")).await?;
    let hello = ws.texts.iter().find(|t| t["type"] == "hello").unwrap().clone();
    ensure!(hello["selfName"] == "e2e-box" && hello["instance"].is_string(), "{hello}");
    let snapshot = ws.call("get_snapshot", json!({})).await?;
    ensure!(snapshot["panes"].as_array().is_some_and(|p| p.iter().any(|p| p["key"] == key)), "the snapshot has the pane");
    ensure!(ws.call("quit_app", json!({})).await.unwrap_err().to_string().contains("isn't available"), "desktop-only calls are refused");
    ws.call("subscribe_frames", json!({})).await?;
    ws.call("set_visible_panes", json!({ "keys": [] })).await?;
    ws.call("stream_pane", json!({ "key": key, "on": true })).await?;
    ws.wait_for("the pane's first screen", Duration::from_secs(10), |w| w.output.iter().any(|(k, kind, _)| *k == key && *kind == 3)).await?;
    ws.call("send_text", json!({ "key": key, "text": "echo typed-over-$((40+2))-ws" })).await?;
    ws.call("send_keys", json!({ "key": key, "keys": ["Enter"] })).await?;
    ws.wait_for("the pane's output after typing", Duration::from_secs(10), |w| w.saw(key, "typed-over-42-ws")).await?;
    println!("ok   the WebSocket: hello, calls, the pane's live output, typing into it");

    // Events reach it: track the pane over the socket, see it come back as an event.
    ws.call("set_pane_notify", json!({ "key": key, "mode": "delay" })).await?;
    ensure!(scratch.sh(&format!("show-options -pqv -t {pid} @chm_notify")) == "delay", "@chm_notify not on the tmux pane");
    ws.wait_for("the tracked pane as an event", Duration::from_secs(5), |w| {
        w.texts.iter().any(|t| t["type"] == "event" && t["event"]["type"] == "panes" && t["event"]["panes"].as_array().is_some_and(|p| p.iter().any(|p| p["key"] == key && !p["notify"].is_null())))
    })
    .await?;
    println!("ok   core events arrive over the socket");

    let mut ts = unix();
    let mut next = || {
        ts += 2;
        ts
    };

    // Another device takes over; the first is told, and its streams and focus pass on.
    let mut ws2 = open_ws(&addr, Some(&origin), Some("e2e")).await?;
    ws.wait_for("the first device told it was taken over", Duration::from_secs(5), |w| w.texts.iter().any(|t| t["type"] == "takenOver")).await?;
    println!("ok   a second device takes over");

    // Looking at the pane from the phone, then the phone going away: pushes aren't held back by
    // a device that's gone.
    ws2.call("set_focus", json!({ "focus": { "expanded": key, "windowFocused": true } })).await?;
    ws2.socket.close(None).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    let stopped = Instant::now();
    hook(&events, &pid, "Stop", next());
    wait_for("a push after the delay, once the phone has gone", Duration::from_secs(10), async || !pushes().is_empty()).await?;
    let p = pushes()[0].clone();
    let after = p.at.duration_since(stopped);
    ensure!(after >= Duration::from_millis(2500), "pushed too early ({after:?})");
    ensure!(p.path == "phone");
    ensure!(p.payload["title"].as_str().is_some_and(|t| t.ends_with("is done")), "title: {}", p.payload);
    ensure!(p.payload["url"].as_str().is_some_and(|u| u.starts_with("/#pane=") && u.ends_with(&pid.replace('%', "%25"))), "url: {}", p.payload);
    ensure!(p.urgency == "normal");
    let token = p.authorization.strip_prefix("vapid t=").and_then(|v| v.split(", k=").next()).context("vapid header")?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').nth(1).unwrap())?)?;
    ensure!(claims["aud"] == format!("http://{push_addr}") && claims["sub"] == "https://e2e.example", "claims: {claims}");
    wait_for("the dead subscription forgotten (410)", Duration::from_secs(10), async || api.state().await.subscriptions.len() == 1).await?;
    tokio::time::sleep(Duration::from_secs(4)).await;
    ensure!(pushes().len() == 1, "one push per turn: {:?}", pushes());

    // Back to work before the delay: nothing.
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    hook(&events, &pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(1200)).await;
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_secs(4)).await;
    ensure!(pushes().len() == 1, "pushed although the agent went back to work");
    println!("ok   back to work before the delay: no push");

    // Seen on a device (another app wrote @chm_seen): nothing.
    hook(&events, &pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(800)).await;
    scratch.sh(&format!("set-option -p -t {pid} @chm_seen {}", unix()));
    tokio::time::sleep(Duration::from_secs(5)).await;
    ensure!(pushes().len() == 1, "pushed although the pane was seen");
    println!("ok   seen on a device: no push");

    // Needs input → urgent push after ~2 s.
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    let asked = Instant::now();
    hook(&events, &pid, "PermissionRequest", next());
    wait_for("a needs-input push", Duration::from_secs(10), async || pushes().len() == 2).await?;
    let p = pushes()[1].clone();
    let after = p.at.duration_since(asked);
    ensure!(after >= Duration::from_millis(1500) && after < Duration::from_millis(3500), "needs input pushed after {after:?}");
    ensure!(p.urgency == "high" && p.payload["title"].as_str().is_some_and(|t| t.ends_with("needs you")), "{p:?}");
    println!("ok   needs input: urgent push after {after:?}");

    // A machine added from the app (it won't connect; it only has to be kept).
    let mut ws3 = open_ws(&addr, Some(&origin), Some("e2e")).await?;
    ws3.call("upsert_host", json!({ "config": { "id": "nowhere-e2e", "address": "127.0.0.1", "port": 9, "user": "nobody", "auth": { "kind": "auto" }, "autoConnect": false } })).await?;
    ensure!(ws3.call("upsert_host", json!({ "config": { "id": "", "user": "x" } })).await.is_err(), "a machine needs a name");

    // Settings from the app, applied at once: paused, nothing; resumed with a shorter delay,
    // the push comes sooner.
    ws3.call("set_notify_prefs", json!({ "prefs": { "pausedUntil": unix() + 3600, "needsInputSecs": 2, "finishedSecs": 3 } })).await?;
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    hook(&events, &pid, "Stop", next());
    tokio::time::sleep(Duration::from_secs(5)).await;
    ensure!(pushes().len() == 2, "pushed while paused");
    ws3.call("set_notify_prefs", json!({ "prefs": { "pausedUntil": null, "needsInputSecs": 2, "finishedSecs": 1 } })).await?;
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    let stopped = Instant::now();
    hook(&events, &pid, "Stop", next());
    wait_for("a push after the shorter delay", Duration::from_secs(5), async || pushes().len() == 3).await?;
    let after = pushes()[2].at.duration_since(stopped);
    ensure!(after < Duration::from_millis(2500), "the new 1 s delay wasn't used ({after:?})");
    println!("ok   paused from the app: no push; resumed with 1 s: pushed after {after:?}");

    // The pane closes before the delay: nothing.
    hook(&events, &pid, "UserPromptSubmit", next());
    tokio::time::sleep(Duration::from_millis(600)).await;
    hook(&events, &pid, "Stop", next());
    tokio::time::sleep(Duration::from_millis(800)).await;
    scratch.sh(&format!("kill-pane -t {pid}"));
    tokio::time::sleep(Duration::from_secs(5)).await;
    ensure!(pushes().len() == 3, "pushed for a closed pane");
    println!("ok   pane closed before the delay: no push");

    // Stop; what lasts is there on the next run.
    let export = ctl::request(&sock, &Request::Export).await?;
    ensure!(export["subscriptions"].as_array().map(Vec::len) == Some(1) && export["vapid"]["privateKey"].is_string(), "{export}");
    ctl::request(&sock, &Request::Stop).await?;
    let exited = tokio::time::timeout(Duration::from_secs(10), child.wait()).await.context("it didn't stop")??;
    ensure!(exited.success(), "exited with {exited}");
    ensure!(!scratch.run_dir().exists(), "its run folder is still there");
    let (mut child, addr) = scratch.run().await?;
    let mut ws4 = open_ws(&addr, Some(&origin), Some("e2e")).await?;
    let snapshot = ws4.call("get_snapshot", json!({})).await?;
    ensure!(snapshot["config"]["hosts"].as_array().is_some_and(|h| h.iter().any(|h| h["id"] == "nowhere-e2e")), "the machine added from the app is kept");
    let status = ctl::request(&sock, &Request::Status).await?;
    ensure!(status["subscriptions"] == 1, "the phones are kept (the forgotten one stays forgotten): {status}");
    println!("ok   machines and phones survive a restart");
    ctl::request(&sock, &Request::Stop).await?;
    tokio::time::timeout(Duration::from_secs(10), child.wait()).await.context("it didn't stop")??;

    // Uninstall leaves nothing.
    let out = scratch.command("uninstall").output().await?;
    ensure!(out.status.success(), "uninstall: {}", String::from_utf8_lossy(&out.stderr));
    ensure!(!scratch.home().exists() && !scratch.run_dir().exists(), "uninstall left files");
    ensure!(String::from_utf8_lossy(&out.stdout).contains("Left in place"), "it says what stays");
    println!("ok   uninstall removes its folders");
    println!("all server checks passed");
    Ok(())
}
