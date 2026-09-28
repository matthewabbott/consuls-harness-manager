//! Host-key verification: pinned keys from Tailscale, otherwise trust-on-first-use.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use russh::keys::{HashAlg, PublicKey};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Matches a pinned (Tailscale) key or a previously trusted key.
    Trusted,
    /// First time we've seen this host; the key has been stored.
    NewlyTrusted { fingerprint: String },
    /// The server presented a key we don't expect. Possible MITM; refuse.
    Mismatch { presented: String, expected: Vec<String> },
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn parse_openssh(line: &str) -> Option<PublicKey> {
    PublicKey::from_openssh(line.trim()).ok()
}

/// TOFU store persisted as JSON: `{ "host-id": ["ssh-ed25519 AAAA…", …] }`.
pub struct KnownHosts {
    path: Option<PathBuf>,
    entries: Mutex<BTreeMap<String, Vec<String>>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let entries = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { path: Some(path), entries: Mutex::new(entries) }
    }

    pub fn in_memory() -> Self {
        Self { path: None, entries: Mutex::new(BTreeMap::new()) }
    }

    /// Checks `presented` for `host`. `pinned` keys (from Tailscale) take precedence over the
    /// TOFU store, because Tailscale's control plane is the more trustworthy source.
    pub fn verify(&self, host: &str, presented: &PublicKey, pinned: &[String]) -> Verdict {
        let pinned: Vec<PublicKey> = pinned.iter().filter_map(|l| parse_openssh(l)).collect();
        if !pinned.is_empty() {
            return if pinned.iter().any(|k| k.key_data() == presented.key_data()) {
                Verdict::Trusted
            } else {
                Verdict::Mismatch {
                    presented: fingerprint(presented),
                    expected: pinned.iter().map(fingerprint).collect(),
                }
            };
        }

        let mut entries = self.entries.lock().unwrap();
        match entries.get(host) {
            Some(lines) => {
                let known: Vec<PublicKey> = lines.iter().filter_map(|l| parse_openssh(l)).collect();
                if known.iter().any(|k| k.key_data() == presented.key_data()) {
                    Verdict::Trusted
                } else {
                    Verdict::Mismatch {
                        presented: fingerprint(presented),
                        expected: known.iter().map(fingerprint).collect(),
                    }
                }
            }
            None => {
                let line = presented.to_openssh().unwrap_or_default();
                entries.insert(host.to_string(), vec![line]);
                drop(entries);
                self.save();
                Verdict::NewlyTrusted { fingerprint: fingerprint(presented) }
            }
        }
    }

    pub fn forget(&self, host: &str) {
        self.entries.lock().unwrap().remove(host);
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let json = {
            let entries = self.entries.lock().unwrap();
            serde_json::to_vec_pretty(&*entries).unwrap_or_default()
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED1: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
    const ED2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC";

    #[test]
    fn pinned_keys_win() {
        let kh = KnownHosts::in_memory();
        let k1 = parse_openssh(ED1).unwrap();
        let k2 = parse_openssh(ED2).unwrap();
        assert_eq!(kh.verify("h", &k1, &[ED1.into()]), Verdict::Trusted);
        assert!(matches!(kh.verify("h", &k2, &[ED1.into()]), Verdict::Mismatch { .. }));
    }

    #[test]
    fn tofu_then_mismatch_then_forget() {
        let kh = KnownHosts::in_memory();
        let k1 = parse_openssh(ED1).unwrap();
        let k2 = parse_openssh(ED2).unwrap();
        assert!(matches!(kh.verify("mac", &k1, &[]), Verdict::NewlyTrusted { .. }));
        assert_eq!(kh.verify("mac", &k1, &[]), Verdict::Trusted);
        assert!(matches!(kh.verify("mac", &k2, &[]), Verdict::Mismatch { .. }));
        kh.forget("mac");
        assert!(matches!(kh.verify("mac", &k2, &[]), Verdict::NewlyTrusted { .. }));
    }
}
