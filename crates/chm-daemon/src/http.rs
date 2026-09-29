//! The phone's web app and its API, on the web app's home. It listens on 127.0.0.1;
//! `tailscale serve` (the notifier's child) publishes it to the tailnet over HTTPS and adds who's
//! asking (`Tailscale-User-Login`, which it strips from what clients send), so only the owner
//! gets in. Every request from the owner is a check-in: it renews the notifier's lease.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Request, State};
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
    if req.method() != Method::GET
        && req.method() != Method::HEAD
        && let Err(why) = same_origin_json(req.headers(), &d)
    {
        return reject(StatusCode::FORBIDDEN, why);
    }
    next.run(req).await
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
    let subscriptions = d
        .sender
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
        .collect();
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
    include!(concat!(env!("OUT_DIR"), "/phone_assets.rs"));
}

/// The web app (built into the binary from `dist-phone/`).
async fn asset(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "phone.html" } else { path };
    let found = assets::ASSETS.iter().find(|(p, _)| *p == path).or_else(|| {
        // App routes without a file behind them get the app.
        (!path.contains('.')).then(|| assets::ASSETS.iter().find(|(p, _)| *p == "phone.html")).flatten()
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
    ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache)], *bytes).into_response()
}
