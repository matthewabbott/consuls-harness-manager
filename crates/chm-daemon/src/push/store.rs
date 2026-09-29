//! The phones (browsers) that asked for pushes, in `subscriptions.json`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A browser's push subscription, as `PushSubscription.toJSON()` gives it (plus our notes).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
    /// What the phone called itself ("iPhone"), for the settings list.
    #[serde(default)]
    pub label: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    #[ts(type = "number")]
    pub added: u64,
    /// When a push last reached its push service.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub last_ok: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct SubscriptionKeys {
    /// The browser's P-256 key, base64url.
    pub p256dh: String,
    /// Its 16-byte auth secret, base64url.
    pub auth: String,
}

/// The subscriptions, in memory: whoever started the notifier keeps the lasting copy.
pub struct Store {
    subs: Mutex<Vec<Subscription>>,
}

impl Store {
    pub fn new(subs: Vec<Subscription>) -> Self {
        Self { subs: Mutex::new(subs) }
    }

    pub fn list(&self) -> Vec<Subscription> {
        self.subs.lock().unwrap().clone()
    }

    pub fn get(&self, endpoint: &str) -> Option<Subscription> {
        self.subs.lock().unwrap().iter().find(|s| s.endpoint == endpoint).cloned()
    }

    /// Adds a subscription, or refreshes the one with the same endpoint.
    pub fn add(&self, mut sub: Subscription, now: u64) {
        let mut subs = self.subs.lock().unwrap();
        match subs.iter_mut().find(|s| s.endpoint == sub.endpoint) {
            Some(existing) => {
                existing.keys = sub.keys;
                if sub.label.is_some() {
                    existing.label = sub.label;
                }
            }
            None => {
                sub.added = now;
                sub.last_ok = None;
                subs.push(sub);
            }
        }
    }

    pub fn remove(&self, endpoint: &str) -> bool {
        let mut subs = self.subs.lock().unwrap();
        let before = subs.len();
        subs.retain(|s| s.endpoint != endpoint);
        subs.len() != before
    }

    pub fn replace(&self, subs: Vec<Subscription>) {
        *self.subs.lock().unwrap() = subs;
    }

    pub fn delivered(&self, endpoint: &str, now: u64) {
        if let Some(s) = self.subs.lock().unwrap().iter_mut().find(|s| s.endpoint == endpoint) {
            s.last_ok = Some(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(endpoint: &str, p256dh: &str) -> Subscription {
        Subscription {
            endpoint: endpoint.into(),
            keys: SubscriptionKeys { p256dh: p256dh.into(), auth: "a".into() },
            label: None,
            added: 0,
            last_ok: None,
        }
    }

    #[test]
    fn dedups_by_endpoint() {
        let store = Store::new(Vec::new());
        store.add(sub("https://web.push.apple.com/1", "k1"), 100);
        store.add(sub("https://web.push.apple.com/1", "k2"), 200);
        store.add(sub("https://web.push.apple.com/2", "k3"), 300);
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].keys.p256dh.as_str(), list[0].added), ("k2", 100), "same endpoint: new keys, first seen kept");
        assert!(store.remove("https://web.push.apple.com/1"));
        assert!(!store.remove("https://web.push.apple.com/1"));
        store.delivered("https://web.push.apple.com/2", 400);
        assert_eq!(store.get("https://web.push.apple.com/2").unwrap().last_ok, Some(400));
        store.replace(vec![]);
        assert!(store.list().is_empty());
    }
}
