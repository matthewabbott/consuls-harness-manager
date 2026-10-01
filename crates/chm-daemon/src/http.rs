//! The phone's web app and its API. It listens on a unix socket only this user can reach;
//! `tailscale serve` (the server's child, as root) publishes it to the tailnet over HTTPS and adds
//! who's asking (`Tailscale-User-Login`, which it strips from what clients send), so only the
//! owner gets in. Every request from the owner is a check-in: it renews the server's lease.
//!
//! The web app drives the core over `/api/ws` (`ws.rs`). That's typing into your shells, so a
//! page from anywhere else must not get to use your Tailscale identity: the WebSocket and every
//! write must come from the web app's own origin.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chm_core::model::{CoreSnapshot, NotifyMode};
use chm_core::notify::PendingPush;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use ts_rs::TS;

use crate::Daemon;
use crate::push::store::Subscription;
use crate::push::{Delivery, Payload, Urgency};

/// Everything the phone's pane list needs, in one request.
#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DaemonState {
    /// This machine's name (its panes are `@local` in the snapshot).
    pub self_host: String,
    pub snapshot: CoreSnapshot,
    pub pending: Vec<PendingPush>,
    /// The key phones subscribe with (`applicationServerKey`).
    pub vapid_public_key: String,
    pub subscriptions: Vec<SubscriptionInfo>,
    /// The daemon's memory use, when known.
    #[ts(type = "number | null")]
    pub rss_kb: Option<u64>,
}

#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubscriptionInfo {
    pub endpoint: String,
    /// The push service's host (`web.push.apple.com`).
    pub service: String,
    pub label: Option<String>,
    #[ts(type = "number")]
    pub added: u64,
    #[ts(type = "number | null")]
    pub last_ok: Option<u64>,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct NotifyRequest {
    pub mode: Option<NotifyMode>,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct EndpointRequest {
    pub endpoint: String,
}

pub fn router(d: Arc<Daemon>) -> Router {
    let guarded = Router::new()
        .route("/api/ws", get(socket))
        .route("/api/paste", post(paste).layer(DefaultBodyLimit::max(21 << 20)))
        .route("/api/push", get(push_info))
        .route("/api/state", get(state))
        .route("/api/panes/{key}/notify", post(notify))
        .route("/api/panes/{key}/seen", post(seen))
        .route("/api/push/subscribe", post(subscribe))
        .route("/api/push/unsubscribe", post(unsubscribe))
        .route("/api/push/test", post(test))
        .fallback(asset)
        .layer(middleware::from_fn_with_state(d.clone(), guard))
        .with_state(d);
    Router::new().route("/healthz", get(|| async { "ok" })).merge(guarded)
}

fn reject(status: StatusCode, why: &str) -> Response {
    (status, why.to_string()).into_response()
}

/// The owner only; and changes only as same-origin JSON (tailnet identity comes with every
/// request from your devices, so a page elsewhere mustn't be able to post here).
async fn guard(State(d): State<Arc<Daemon>>, req: Request, next: Next) -> Response {
    if d.owners.is_empty() {
        return reject(StatusCode::SERVICE_UNAVAILABLE, "no owner: set web.ownerLogins in the notifier's configuration");
    }
    let login = req.headers().get("tailscale-user-login").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !d.owners.iter().any(|o| o.eq_ignore_ascii_case(login)) {
        return reject(StatusCode::FORBIDDEN, "not yours: open it from your own tailnet device, through tailscale serve");
    }
    d.lease.renew(None);
    d.human_here();
    if req.method() != Method::GET && req.method() != Method::HEAD {
        // Images arrive as raw bytes: a header a form can't send stands in for "JSON only".
        let checked = if req.uri().path() == "/api/paste" {
            if req.headers().get("x-consuls").is_some_and(|v| v == "1") { same_origin(req.headers(), &d) } else { Err("not from the web app") }
        } else {
            same_origin_json(req.headers(), &d)
        };
        if let Err(why) = checked {
            return reject(StatusCode::FORBIDDEN, why);
        }
    }
    next.run(req).await
}

/// The browser says where a request comes from (`Origin`): the web app's own address only.
fn same_origin(h: &HeaderMap, d: &Daemon) -> Result<(), &'static str> {
    let origin = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()).ok_or("no origin")?;
    if origin == d.origin || d.config.web.as_ref().is_some_and(|w| w.allow_origins.iter().any(|o| o == origin)) { Ok(()) } else { Err("wrong origin") }
}

/// The web app's live connection. Browsers always send `Origin` with a WebSocket, so one from
/// another site (which would carry your Tailscale identity) is turned away.
async fn socket(State(d): State<Arc<Daemon>>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if let Err(why) = same_origin(&headers, &d) {
        return reject(StatusCode::FORBIDDEN, why);
    }
    upgrade.max_message_size(8 << 20).on_upgrade(move |socket| crate::ws::serve(socket, d))
}

#[derive(Deserialize)]
struct PasteQuery {
    host: String,
    ext: String,
}

/// An image pasted or attached in the composer: saved on the pane's machine; its path comes back.
async fn paste(State(d): State<Arc<Daemon>>, Query(q): Query<PasteQuery>, body: bytes::Bytes) -> Response {
    match d.core.save_paste(&q.host, body.to_vec(), &q.ext).await {
        Ok(path) => Json(path).into_response(),
        Err(e) => reject(StatusCode::BAD_REQUEST, &e),
    }
}

/// The push identity and the phones subscribed, for the app's notification settings.
#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PushInfo {
    pub vapid_public_key: String,
    pub subscriptions: Vec<SubscriptionInfo>,
}

async fn push_info(State(d): State<Arc<Daemon>>) -> Json<PushInfo> {
    Json(PushInfo { vapid_public_key: d.sender.vapid_public_key().to_string(), subscriptions: subscription_infos(&d) })
}

fn subscription_infos(d: &Daemon) -> Vec<SubscriptionInfo> {
    d.sender
        .store()
        .list()
        .into_iter()
        .map(|s| SubscriptionInfo {
            service: s.endpoint.parse::<http::Uri>().ok().and_then(|u| u.host().map(str::to_string)).unwrap_or_default(),
            endpoint: s.endpoint,
            label: s.label,
            added: s.added,
            last_ok: s.last_ok,
        })
        .collect()
}

fn same_origin_json(h: &HeaderMap, d: &Daemon) -> Result<(), &'static str> {
    let text = |name: header::HeaderName| h.get(name).and_then(|v| v.to_str().ok());
    if !text(header::CONTENT_TYPE).is_some_and(|ct| ct.starts_with("application/json")) {
        return Err("JSON only");
    }
    if let Some(site) = h.get("sec-fetch-site").and_then(|v| v.to_str().ok())
        && !matches!(site, "same-origin" | "none")
    {
        return Err("cross-site request");
    }
    if let Some(origin) = text(header::ORIGIN)
        && origin != d.origin
        && !d.config.web.as_ref().is_some_and(|w| w.allow_origins.iter().any(|o| o == origin))
    {
        return Err("wrong origin");
    }
    Ok(())
}

async fn state(State(d): State<Arc<Daemon>>) -> Json<DaemonState> {
    let pending = d.policy.lock().unwrap().pending(Instant::now());
    let subscriptions = subscription_infos(&d);
    Json(DaemonState {
        self_host: d.self_name.clone(),
        snapshot: d.core.snapshot(),
        pending,
        vapid_public_key: d.sender.vapid_public_key().to_string(),
        subscriptions,
        rss_kb: crate::rss_kb(),
    })
}

fn known(d: &Daemon, key: u32) -> bool {
    d.core.snapshot().panes.iter().any(|p| p.key == key)
}

async fn notify(State(d): State<Arc<Daemon>>, Path(key): Path<u32>, Json(req): Json<NotifyRequest>) -> StatusCode {
    if !known(&d, key) {
        return StatusCode::NOT_FOUND;
    }
    d.core.set_pane_notify(key, req.mode);
    StatusCode::NO_CONTENT
}

/// The phone showed you the pane: no push for what you've seen.
async fn seen(State(d): State<Arc<Daemon>>, Path(key): Path<u32>) -> StatusCode {
    if !known(&d, key) {
        return StatusCode::NOT_FOUND;
    }
    d.policy.lock().unwrap().seen(key);
    d.core.mark_pane_seen(key);
    StatusCode::NO_CONTENT
}

async fn subscribe(State(d): State<Arc<Daemon>>, Json(sub): Json<Subscription>) -> Response {
    if let Err(e) = d.sender.check_endpoint(&sub.endpoint) {
        return reject(StatusCode::BAD_REQUEST, &e.to_string());
    }
    d.sender.store().add(sub, crate::push::now());
    StatusCode::NO_CONTENT.into_response()
}

async fn unsubscribe(State(d): State<Arc<Daemon>>, Json(req): Json<EndpointRequest>) -> StatusCode {
    if d.sender.store().remove(&req.endpoint) { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }
}

/// A test notification to one device.
async fn test(State(d): State<Arc<Daemon>>, Json(req): Json<EndpointRequest>) -> Response {
    let Some(sub) = d.sender.store().get(&req.endpoint) else { return reject(StatusCode::NOT_FOUND, "not subscribed") };
    let payload = Payload { title: format!("Hello from {}", d.self_name), body: "Notifications work.".into(), tag: "test".into(), url: "/".into() };
    match d.sender.to(&sub, &payload, Urgency::High).await {
        Delivery::Sent => StatusCode::NO_CONTENT.into_response(),
        Delivery::Gone => reject(StatusCode::GONE, "this device's subscription has expired; enable notifications again"),
        Delivery::Failed(e) => reject(StatusCode::BAD_GATEWAY, &e),
    }
}

mod assets {
    include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));
}

/// The web app (built into the binary from `dist-web/`).
async fn asset(State(d): State<Arc<Daemon>>, req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let found = assets::ASSETS.iter().find(|(p, _)| *p == path).or_else(|| {
        // App routes without a file behind them get the app.
        (!path.contains('.')).then(|| assets::ASSETS.iter().find(|(p, _)| *p == "index.html")).flatten()
    });
    let Some((name, bytes)) = found else { return StatusCode::NOT_FOUND.into_response() };
    let mime = match name.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    // Hashed build files never change; the page and the service worker always might.
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let mut res = ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache)], *bytes).into_response();
    if mime.starts_with("text/html") {
        // A script that got in somehow could drive every machine: only the app's own scripts run,
        // and it talks to nothing but its own server.
        let wss = d.origin.replacen("https://", "wss://", 1);
        let csp = format!(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; \
             connect-src 'self' {wss}; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        );
        if let Ok(v) = csp.parse() {
            res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, v);
        }
    }
    res
}
