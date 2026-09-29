//! The phones (browsers) that asked for pushes, in `subscriptions.json`.

use std::path::PathBuf;
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

pub struct Store {
    path: PathBuf,
    subs: Mutex<Vec<Subscription>>,
}

impl Store {
    pub fn load(path: PathBuf) -> anyhow::Result<Self> {
        let subs = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, subs: Mutex::new(subs) })
    }

    pub fn list(&self) -> Vec<Subscription> {
        self.subs.lock().unwrap().clone()
    }

    pub fn get(&self, endpoint: &str) -> Option<Subscription> {
        self.subs.lock().unwrap().iter().find(|s| s.endpoint == endpoint).cloned()
    }

    /// Adds a subscription, or refreshes the one with the same endpoint.
    pub fn add(&self, mut sub: Subscription, now: u64) -> anyhow::Result<()> {
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
        self.save(&subs)
    }

    pub fn remove(&self, endpoint: &str) -> anyhow::Result<bool> {
        let mut subs = self.subs.lock().unwrap();
        let before = subs.len();
        subs.retain(|s| s.endpoint != endpoint);
        let removed = subs.len() != before;
        if removed {
            self.save(&subs)?;
        }
        Ok(removed)
    }

    pub fn delivered(&self, endpoint: &str, now: u64) {
        let mut subs = self.subs.lock().unwrap();
        if let Some(s) = subs.iter_mut().find(|s| s.endpoint == endpoint) {
            s.last_ok = Some(now);
            let _ = self.save(&subs);
        }
    }

    fn save(&self, subs: &[Subscription]) -> anyhow::Result<()> {
        crate::files::write_private(&self.path, serde_json::to_string_pretty(subs)?.as_bytes())
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
    fn dedups_by_endpoint_and_persists() {
        let dir = std::env::temp_dir().join(format!("chm-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("subscriptions.json");
        let store = Store::load(path.clone()).unwrap();
        store.add(sub("https://web.push.apple.com/1", "k1"), 100).unwrap();
        store.add(sub("https://web.push.apple.com/1", "k2"), 200).unwrap();
        store.add(sub("https://web.push.apple.com/2", "k3"), 300).unwrap();
        let again = Store::load(path.clone()).unwrap();
        let list = again.list();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].keys.p256dh.as_str(), list[0].added), ("k2", 100), "same endpoint: new keys, first seen kept");
        assert!(again.remove("https://web.push.apple.com/1").unwrap());
        assert!(!again.remove("https://web.push.apple.com/1").unwrap());
        assert_eq!(Store::load(path.clone()).unwrap().list().len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
