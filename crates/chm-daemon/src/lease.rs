//! How long the notifier keeps going without hearing from you: every check-in (the app, the web
//! app, `ctl renew`) extends it; when it runs out, the notifier stops and cleans up. Measured by
//! the wall clock: a Mac's monotonic clock stops while it sleeps.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct Lease {
    until: Mutex<SystemTime>,
    length: Mutex<Duration>,
}

impl Lease {
    pub fn new(length: Duration) -> Self {
        Self { until: Mutex::new(SystemTime::now() + length), length: Mutex::new(length) }
    }

    /// Sets how long a check-in extends it (at most 30 days), and checks in.
    pub fn set_length(&self, length: Duration) {
        *self.length.lock().unwrap() = length.min(Duration::from_secs(30 * 86_400));
        self.renew(None);
    }

    /// Extends it to `length` (default: the configured one) from now.
    pub fn renew(&self, length: Option<Duration>) -> SystemTime {
        let length = length.unwrap_or(*self.length.lock().unwrap()).min(Duration::from_secs(30 * 86_400));
        let until = SystemTime::now() + length;
        *self.until.lock().unwrap() = until;
        until
    }

    /// Time left, or `None` once it has run out.
    pub fn remaining(&self) -> Option<Duration> {
        self.until.lock().unwrap().duration_since(SystemTime::now()).ok().filter(|d| !d.is_zero())
    }

    /// When it runs out, unix seconds.
    pub fn until_unix(&self) -> u64 {
        self.until.lock().unwrap().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
    }
}

/// Resolves when the lease runs out (checked at least every 10 minutes, and right after a
/// machine wakes, since the wall clock is what counts).
pub async fn expiry(lease: &Lease) {
    loop {
        match lease.remaining() {
            None => return,
            Some(left) => tokio::time::sleep(left.min(Duration::from_secs(600))).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renew_and_run_out() {
        let lease = Lease::new(Duration::from_secs(3600));
        assert!(lease.remaining().unwrap() > Duration::from_secs(3590));
        *lease.until.lock().unwrap() = SystemTime::now() - Duration::from_secs(1);
        assert!(lease.remaining().is_none(), "run out");
        lease.renew(None);
        assert!(lease.remaining().is_some(), "a check-in revives it");
        lease.set_length(Duration::from_secs(365 * 86_400));
        assert!(lease.remaining().unwrap() <= Duration::from_secs(30 * 86_400), "capped at 30 days");
    }

    #[tokio::test]
    async fn expiry_resolves() {
        let lease = Lease::new(Duration::from_millis(200));
        tokio::time::timeout(Duration::from_secs(5), expiry(&lease)).await.expect("the lease ran out");
    }
}
