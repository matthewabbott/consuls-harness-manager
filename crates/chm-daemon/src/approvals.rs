//! When to push "approve SSH to …" (Tailscale SSH's check). Every reconnect brings a new link,
//! so pushing per link nags; instead each machine gets one push, then none until a person shows
//! up (opens the web app, or the phone app or script checks in). None while one is looking at
//! the app either: it shows the Approve button itself.

use std::collections::HashSet;
use std::time::{Duration, Instant};

/// Someone counts as looking at the app for this long after their last request.
const LOOKING: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Approvals {
    pushed: HashSet<String>,
    human_at: Option<Instant>,
}

impl Approvals {
    /// A person is here: the next check may push again.
    pub fn human(&mut self, now: Instant) {
        self.pushed.clear();
        self.human_at = Some(now);
    }

    /// Whether `host`'s check should push now (and, if so, that it has).
    pub fn due(&mut self, host: &str, now: Instant) -> bool {
        if self.human_at.is_some_and(|t| now.duration_since(t) < LOOKING) {
            return false;
        }
        self.pushed.insert(host.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_push_per_machine_until_someone_comes() {
        let t = Instant::now();
        let mut a = Approvals::default();
        assert!(a.due("spark2", t));
        assert!(!a.due("spark2", t + Duration::from_secs(30)), "a new link isn't a new push");
        assert!(a.due("mac", t), "another machine pushes once too");
        a.human(t + Duration::from_secs(100));
        assert!(!a.due("spark2", t + Duration::from_secs(110)), "not while they're looking at the app");
        assert!(a.due("spark2", t + Duration::from_secs(200)), "after they've been, again once");
        assert!(!a.due("spark2", t + Duration::from_secs(300)));
    }
}
