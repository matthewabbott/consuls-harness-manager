//! Download links. The web app asks for one over its socket (`download_token`), then fetches
//! `/api/download?t=…`, which a plain link, an image and the share sheet can all use. A link is
//! good for one file for five minutes, and can be fetched again meanwhile: iOS fetches a file
//! again for its previews and the share sheet.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct Grants(Mutex<HashMap<String, Grant>>);

struct Grant {
    host: String,
    path: String,
    until: Instant,
}

impl Grants {
    /// A fresh link to `path` on `host`: 128 random bits.
    pub fn issue(&self, host: String, path: String) -> Result<String, String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|e| format!("no randomness: {e}"))?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let now = Instant::now();
        let mut grants = self.0.lock().unwrap();
        grants.retain(|_, g| g.until > now);
        grants.insert(token.clone(), Grant { host, path, until: now + TTL });
        Ok(token)
    }

    /// The machine and file a link is for, while it's good.
    pub fn get(&self, token: &str) -> Option<(String, String)> {
        let grants = self.0.lock().unwrap();
        grants.get(token).filter(|g| g.until > Instant::now()).map(|g| (g.host.clone(), g.path.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_random_and_reusable() {
        let g = Grants::default();
        let a = g.issue("spark".into(), "/home/u/a.txt".into()).unwrap();
        let b = g.issue("spark".into(), "/home/u/a.txt".into()).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_eq!(g.get(&a), Some(("spark".into(), "/home/u/a.txt".into())));
        assert_eq!(g.get(&a), Some(("spark".into(), "/home/u/a.txt".into())), "good more than once");
        assert_eq!(g.get("0123"), None);
        g.0.lock().unwrap().get_mut(&a).unwrap().until = Instant::now();
        assert_eq!(g.get(&a), None, "expired");
    }
}
