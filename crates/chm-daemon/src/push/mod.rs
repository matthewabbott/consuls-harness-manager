//! Sending pushes: standard Web Push to every browser that subscribed (a home-screen web app on
//! the phone). A native app's APNs could slot in beside it later.

pub mod store;
pub mod vapid;
pub mod webpush;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde::Serialize;
use tracing::{debug, info, warn};

use store::{Store, Subscription};
use vapid::Vapid;

/// Push services a subscription may point at (anything else is refused: the daemon would
/// otherwise POST wherever a request told it to).
const PUSH_SERVICES: [&str; 4] = ["push.apple.com", "fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com"];

/// What the phone's service worker shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Payload {
    pub title: String,
    pub body: String,
    /// One per pane: a newer notification replaces the older one.
    pub tag: String,
    /// Opened when the notification is tapped (inside the app, or e.g. a Tailscale approval).
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Normal,
    High,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    /// The subscription is dead (the app was removed, or permission withdrawn); forgotten.
    Gone,
    Failed(String),
}

pub struct Sender {
    vapid: Vapid,
    store: Arc<Store>,
    client: Client<HttpsConnector<HttpConnector>, Full<Bytes>>,
    /// Tests: plain-http push services on this machine.
    allow_insecure: bool,
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Sender {
    pub fn new(vapid: Vapid, store: Arc<Store>, allow_insecure: bool) -> anyhow::Result<Self> {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let https = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(tls).https_or_http().enable_http1().enable_http2().build();
        Ok(Self { vapid, store, client: Client::builder(TokioExecutor::new()).build(https), allow_insecure })
    }

    pub fn vapid_public_key(&self) -> &str {
        self.vapid.public_key()
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Whether a subscription's endpoint is a push service we'll send to.
    pub fn check_endpoint(&self, endpoint: &str) -> anyhow::Result<()> {
        let uri: http::Uri = endpoint.parse().context("bad endpoint")?;
        let host = uri.host().unwrap_or_default();
        match uri.scheme_str() {
            Some("https") if PUSH_SERVICES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}"))) => Ok(()),
            Some("http") if self.allow_insecure && matches!(host, "127.0.0.1" | "localhost") => Ok(()),
            _ => Err(anyhow!("{host} isn't a push service")),
        }
    }

    /// Sends to every subscribed browser; forgets the ones that are gone.
    pub async fn to_all(&self, payload: &Payload, urgency: Urgency) {
        let subs = self.store.list();
        if subs.is_empty() {
            info!("no phone to push to (open the web app and enable notifications): {}", payload.title);
        }
        for sub in subs {
            match self.to(&sub, payload, urgency).await {
                Delivery::Sent => debug!("pushed to {}", host_of(&sub.endpoint)),
                Delivery::Gone => info!("{} is gone; forgot it", host_of(&sub.endpoint)),
                Delivery::Failed(e) => warn!("push to {} failed: {e}", host_of(&sub.endpoint)),
            }
        }
    }

    /// Sends to one browser, retrying a busy push service a few times.
    pub async fn to(&self, sub: &Subscription, payload: &Payload, urgency: Urgency) -> Delivery {
        let mut wait = Duration::from_secs(2);
        for attempt in 1..=3 {
            match self.post(sub, payload, urgency).await {
                Ok((status, _)) if status.is_success() => {
                    self.store.delivered(&sub.endpoint, now());
                    return Delivery::Sent;
                }
                Ok((status, _)) if status == http::StatusCode::NOT_FOUND || status == http::StatusCode::GONE => {
                    self.store.remove(&sub.endpoint);
                    return Delivery::Gone;
                }
                Ok((status, retry_after)) if (status == http::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempt < 3 => {
                    tokio::time::sleep(retry_after.unwrap_or(wait).min(Duration::from_secs(30))).await;
                    wait *= 2;
                }
                Ok((status, _)) => return Delivery::Failed(format!("the push service said {status}")),
                Err(e) if attempt < 3 => {
                    debug!("push attempt {attempt} failed: {e:#}");
                    tokio::time::sleep(wait).await;
                    wait *= 2;
                }
                Err(e) => return Delivery::Failed(format!("{e:#}")),
            }
        }
        Delivery::Failed("gave up".into())
    }

    async fn post(&self, sub: &Subscription, payload: &Payload, urgency: Urgency) -> anyhow::Result<(http::StatusCode, Option<Duration>)> {
        self.check_endpoint(&sub.endpoint)?;
        let p256dh = URL_SAFE_NO_PAD.decode(sub.keys.p256dh.trim_end_matches('=')).context("bad p256dh")?;
        let auth = URL_SAFE_NO_PAD.decode(sub.keys.auth.trim_end_matches('=')).context("bad auth")?;
        let body = webpush::encrypt(&p256dh, &auth, &serde_json::to_vec(&short(payload))?)?;
        let request = http::Request::post(&sub.endpoint)
            .header("TTL", "3600")
            .header("Urgency", if urgency == Urgency::High { "high" } else { "normal" })
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", self.vapid.authorization(&sub.endpoint, now())?)
            .body(Full::new(Bytes::from(body)))?;
        let response = tokio::time::timeout(Duration::from_secs(20), self.client.request(request)).await.context("timed out")??;
        let status = response.status();
        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).map(Duration::from_secs);
        if !status.is_success() {
            let text = response.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
            debug!("push service replied {status}: {}", String::from_utf8_lossy(&text[..text.len().min(300)]));
        }
        Ok((status, retry_after))
    }
}

/// Push messages must stay small (about 4 KB with encryption).
fn short(p: &Payload) -> Payload {
    let cut = |s: &str, n: usize| if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s.to_string() };
    Payload { title: cut(&p.title, 120), body: cut(&p.body, 400), tag: cut(&p.tag, 120), url: cut(&p.url, 1000) }
}

fn host_of(endpoint: &str) -> String {
    endpoint.parse::<http::Uri>().ok().and_then(|u| u.host().map(str::to_string)).unwrap_or_else(|| "?".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sender(insecure: bool) -> Sender {
        let store = Arc::new(Store::new(Vec::new()));
        Sender::new(Vapid::new(p256::elliptic_curve::Generate::generate(), "https://x".into()), store, insecure).unwrap()
    }

    #[test]
    fn only_push_services() {
        let s = sender(false);
        for ok in ["https://web.push.apple.com/abc", "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"] {
            assert!(s.check_endpoint(ok).is_ok(), "{ok}");
        }
        for bad in ["https://evil.example/push", "https://push.apple.com.evil.example/x", "http://web.push.apple.com/x", "http://127.0.0.1:9000/p", "ftp://x"] {
            assert!(s.check_endpoint(bad).is_err(), "{bad}");
        }
        assert!(sender(true).check_endpoint("http://127.0.0.1:9000/p").is_ok(), "tests may use a local fake");
    }

    #[test]
    fn payloads_stay_small() {
        let p = Payload { title: "t".repeat(500), body: "b".repeat(5000), tag: "x".into(), url: "/".into() };
        let s = short(&p);
        assert!(s.title.chars().count() <= 121 && s.body.chars().count() <= 401);
        assert!(serde_json::to_vec(&s).unwrap().len() < 3000);
    }
}
