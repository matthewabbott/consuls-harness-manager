//! When to push to your phone (the Consuls server's policy). It's fed the core's events and
//! alerts, and returns the pushes to send; the caller owns the clock and the sending.
//!
//! Only tracked tmux panes push (`@chm_notify`, see [`NotifyMode`]). The default mode waits:
//! a push goes out if the agent is *still* waiting after a delay — unless it went back to work,
//! tracking was turned off, the pane went away, or a device showed it to you meanwhile
//! (`@chm_seen`). Every piece of shared state lives on the tmux pane, so panes are keyed by the
//! server's own pane keys. The delays and a pause come from the server's settings
//! ([`NotifyPrefs`], in its core's config), and apply to pushes already waiting.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use ts_rs::TS;

use crate::local::LOCAL_HOST;
use crate::model::{Activity, Alert, AlertKind, CoreEvent, HostId, HostPhase, NotifyMode, NotifyPrefs, PaneKind};

/// How long a waiting agent waits before its push, in the default mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delays {
    pub needs_input: Duration,
    pub finished: Duration,
}

impl Default for Delays {
    fn default() -> Self {
        Self::from(&NotifyPrefs::default())
    }
}

impl From<&NotifyPrefs> for Delays {
    fn from(p: &NotifyPrefs) -> Self {
        Self { needs_input: Duration::from_secs(p.needs_input_secs), finished: Duration::from_secs(p.finished_secs) }
    }
}

/// A device's "seen" counts for an alert up to this many seconds before it: clocks differ a
/// little, and the seen mark and the hook event reach the server in either order.
const SEEN_SLACK: u64 = 10;

/// The modes that push on a turn's end still wait this long, so a desktop showing the pane
/// (which marks it seen just after the alert) can cancel it.
const GRACE: Duration = Duration::from_secs(SEEN_SLACK);

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A notification to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push {
    pub key: u32,
    /// The machine, by its tailnet name (never `@local`).
    pub host: HostId,
    /// tmux's pane id, e.g. `%3`.
    pub pane_id: String,
    pub kind: AlertKind,
    pub title: String,
    pub body: String,
    /// One per pane: a newer notification replaces the older one on the phone.
    pub tag: String,
}

/// A push still to come, for the phone's pane list.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PendingPush {
    pub key: u32,
    pub kind: AlertKind,
    /// Milliseconds until it goes out.
    pub due_in_ms: u32,
}

#[derive(Debug, Clone)]
struct Pending {
    kind: AlertKind,
    /// When the alert came in: its due time follows from the delays and mode at the time.
    at: Instant,
    /// The daemon's clock (unix seconds) when the alert came in.
    alert_wall: u64,
    title: String,
    body: String,
}

#[derive(Debug, Clone)]
struct PaneState {
    host: HostId,
    pane_id: String,
    notify: Option<NotifyMode>,
    seen: Option<u64>,
    pending: Option<Pending>,
}

#[derive(Default)]
pub struct Policy {
    delays: Delays,
    /// No pushes until then (unix seconds).
    paused_until: Option<u64>,
    panes: HashMap<u32, PaneState>,
    /// Kept apart from `panes`: an attention update can arrive before the pane list.
    activity: HashMap<u32, Activity>,
    /// When each pane last went back to work (the core's clock, unix seconds): a device's
    /// "seen" from before then was about an earlier turn.
    worked: HashMap<u32, u64>,
    connected: HashMap<HostId, bool>,
    /// This machine's tailnet name, for `@local` panes.
    self_name: Option<String>,
    /// A name given instead (wins over the tailnet's).
    given_name: Option<String>,
}

impl Policy {
    pub fn new(delays: Delays) -> Self {
        Self { delays, ..Default::default() }
    }

    /// Names this machine in pushes, instead of its tailnet name.
    pub fn name_this_machine(&mut self, name: String) {
        self.given_name = Some(name);
    }

    /// The server's settings: the delays (for pushes already waiting too) and a pause, which
    /// drops what's waiting.
    pub fn set_prefs(&mut self, prefs: &NotifyPrefs, wall: u64) {
        self.delays = Delays::from(prefs);
        self.paused_until = prefs.paused_until;
        if prefs.paused_at(wall) {
            for p in self.panes.values_mut() {
                p.pending = None;
            }
        }
    }

    /// When `pending` is due, given the pane's mode now; None: it no longer pushes at all.
    fn due_at(delays: Delays, mode: Option<NotifyMode>, pending: &Pending) -> Option<Instant> {
        let delay = match (mode?, pending.kind) {
            (NotifyMode::Delay, AlertKind::NeedsInput) => delays.needs_input,
            (NotifyMode::Delay, _) => delays.finished,
            (NotifyMode::Any, _) => GRACE,
            (NotifyMode::Finished, AlertKind::Finished) => GRACE,
            // Questions and permission prompts don't push in this mode.
            (NotifyMode::Finished, _) => return None,
        };
        Some(pending.at + delay)
    }

    /// Takes in a core event (pane lists, attention, hosts, the tailnet).
    pub fn event(&mut self, event: &CoreEvent) {
        match event {
            CoreEvent::Panes { host, panes } => {
                let mut alive = Vec::new();
                for p in panes.iter().filter(|p| p.kind == PaneKind::Tmux) {
                    let Some(tmux) = &p.tmux else { continue };
                    alive.push(p.key);
                    let state = self.panes.entry(p.key).or_insert_with(|| PaneState {
                        host: host.clone(),
                        pane_id: tmux.pane_id.clone(),
                        notify: None,
                        seen: None,
                        pending: None,
                    });
                    state.pane_id = tmux.pane_id.clone();
                    state.notify = p.notify;
                    state.seen = p.seen;
                    if state.notify.is_none() {
                        state.pending = None;
                    }
                }
                let gone: Vec<u32> = self.panes.iter().filter(|(k, s)| s.host == *host && !alive.contains(k)).map(|(k, _)| *k).collect();
                for key in gone {
                    self.panes.remove(&key);
                    self.activity.remove(&key);
                    self.worked.remove(&key);
                }
            }
            CoreEvent::Attention { state } => {
                self.activity.insert(state.key, state.activity);
                if state.activity == Activity::Working {
                    self.worked.insert(state.key, state.since as u64);
                }
                if matches!(state.activity, Activity::Working | Activity::Unknown)
                    && let Some(p) = self.panes.get_mut(&state.key)
                {
                    p.pending = None;
                }
            }
            CoreEvent::Host { state } => {
                self.connected.insert(state.id.clone(), state.phase == HostPhase::Connected);
            }
            CoreEvent::HostRemoved { id } => {
                self.connected.remove(id);
                let gone: Vec<u32> = self.panes.iter().filter(|(_, s)| s.host == *id).map(|(k, _)| *k).collect();
                for key in gone {
                    self.panes.remove(&key);
                    self.activity.remove(&key);
                    self.worked.remove(&key);
                }
            }
            CoreEvent::Tailnet { status } => {
                if let Some(me) = &status.self_node {
                    self.self_name = Some(me.id.clone());
                }
            }
            // Comes with every save of the config (labels, machines…): cheap to apply again.
            CoreEvent::Config { config } => self.set_prefs(&config.notify, unix_now()),
            _ => {}
        }
    }

    /// Takes in an alert. Returns what goes out right away (with a zero delay); the rest comes
    /// back from [`Policy::due`].
    pub fn alert(&mut self, alert: &Alert, now: Instant, wall: u64) -> Vec<Push> {
        let (Some(key), kind) = (alert.key, alert.kind) else { return Vec::new() };
        if !matches!(kind, AlertKind::Finished | AlertKind::NeedsInput) || self.paused_until.is_some_and(|t| t > wall) {
            return Vec::new();
        }
        let delays = self.delays;
        let Some(p) = self.panes.get_mut(&key) else { return Vec::new() };
        let pending = Pending { kind, at: now, alert_wall: wall, title: alert.title.clone(), body: alert.body.clone() };
        let Some(due) = Self::due_at(delays, p.notify, &pending) else { return Vec::new() };
        // A newer alert replaces the pending one.
        p.pending = Some(pending);
        if due <= now { self.due(now) } else { Vec::new() }
    }

    /// The phone showed you the pane: its pending push is dropped.
    pub fn seen(&mut self, key: u32) {
        if let Some(p) = self.panes.get_mut(&key) {
            p.pending = None;
        }
    }

    /// Pushes whose time has come, each checked again: still tracked, still waiting, not seen
    /// since the alert, and its machine reachable. One that fails a check is dropped, not put off.
    pub fn due(&mut self, now: Instant) -> Vec<Push> {
        let mut out = Vec::new();
        let self_name = self.given_name.clone().or_else(|| self.self_name.clone()).unwrap_or_else(|| "this machine".into());
        let delays = self.delays;
        for (&key, p) in self.panes.iter_mut() {
            let Some(pending) = &p.pending else { continue };
            match Self::due_at(delays, p.notify, pending) {
                // Its mode no longer pushes it.
                None => {
                    p.pending = None;
                    continue;
                }
                Some(due) if due > now => continue,
                Some(_) => {}
            }
            let Some(pending) = p.pending.take() else { continue };
            let waiting = matches!(self.activity.get(&key), Some(Activity::Idle | Activity::NeedsInput));
            // Seen since this turn's alert (give or take the slack), and not before the agent
            // last went back to work (that was an earlier turn).
            let worked = self.worked.get(&key).copied();
            let seen = p.seen.is_some_and(|s| s + SEEN_SLACK >= pending.alert_wall && worked.is_none_or(|w| s + 1 >= w));
            let reachable = p.host == LOCAL_HOST || self.connected.get(&p.host).copied().unwrap_or(false);
            if p.notify.is_none() || !waiting || seen || !reachable {
                continue;
            }
            let host = if p.host == LOCAL_HOST { self_name.clone() } else { p.host.clone() };
            let body = pending.body.replace(&format!("on {LOCAL_HOST}"), &format!("on {self_name}"));
            out.push(Push {
                key,
                tag: format!("pane:{host}/{}", p.pane_id),
                host,
                pane_id: p.pane_id.clone(),
                kind: pending.kind,
                title: pending.title,
                body,
            });
        }
        out.sort_by_key(|p| p.key);
        out
    }

    /// When the next pending push is due.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.panes.values().filter_map(|p| p.pending.as_ref().and_then(|q| Self::due_at(self.delays, p.notify, q))).min()
    }

    /// Pushes still to come.
    pub fn pending(&self, now: Instant) -> Vec<PendingPush> {
        let mut out: Vec<PendingPush> = self
            .panes
            .iter()
            .filter_map(|(&key, p)| {
                let q = p.pending.as_ref()?;
                let due = Self::due_at(self.delays, p.notify, q)?;
                Some(PendingPush { key, kind: q.kind, due_in_ms: due.saturating_duration_since(now).as_millis().min(u32::MAX as u128) as u32 })
            })
            .collect();
        out.sort_by_key(|p| p.key);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AttentionLevel, HostState, PaneAttention, PaneInfo, TailnetPeer, TailnetStatus, TmuxLoc};

    const T0: u64 = 1_790_000_000;

    fn pane(key: u32, host: &str, notify: Option<NotifyMode>, seen: Option<u64>) -> PaneInfo {
        PaneInfo {
            key,
            host: host.into(),
            kind: PaneKind::Tmux,
            tmux: Some(TmuxLoc {
                pane_id: format!("%{key}"),
                window_id: "@1".into(),
                session_id: "$1".into(),
                session_name: "s".into(),
                session_group: None,
                window_index: 0,
                window_name: "claude".into(),
                pane_index: 0,
                dead: false,
                window_active: true,
                pane_active: true,
                window_panes: 1,
                sized: false,
                prefix: "C-b".into(),
            }),
            width: 80,
            height: 24,
            current_command: "claude".into(),
            current_path: "/tmp".into(),
            title: String::new(),
            name: None,
            harness: None,
            alternate_on: false,
            chm_id: None,
            hidden: false,
            labels: Vec::new(),
            ended: None,
            bell: None,
            bell_pings: false,
            notify,
            seen,
        }
    }

    fn panes(host: &str, list: Vec<PaneInfo>) -> CoreEvent {
        CoreEvent::Panes { host: host.into(), panes: list }
    }

    fn activity(key: u32, activity: Activity) -> CoreEvent {
        activity_at(key, activity, T0 - 100)
    }

    fn activity_at(key: u32, activity: Activity, since: u64) -> CoreEvent {
        CoreEvent::Attention { state: PaneAttention { key, activity, attention: AttentionLevel::Unacked, since: since as f64, ..Default::default() } }
    }

    fn connected(host: &str, yes: bool) -> CoreEvent {
        CoreEvent::Host { state: HostState { id: host.into(), phase: if yes { HostPhase::Connected } else { HostPhase::Disconnected }, facts: None } }
    }

    fn alert(key: u32, kind: AlertKind, host: &str) -> Alert {
        let title = match kind {
            AlertKind::NeedsInput => "refactor needs you",
            _ => "refactor is done",
        };
        Alert { key: Some(key), kind, title: title.into(), body: format!("Finished — your turn · Claude Code on {host}"), sound: true, toast: true, flash: true }
    }

    /// A policy with pane 1 on spark2 (connected), tracked with `mode`, waiting (`kind`).
    fn setup(mode: Option<NotifyMode>) -> Policy {
        let mut p = Policy::new(Delays { needs_input: Duration::from_secs(60), finished: Duration::from_secs(180) });
        p.event(&connected("spark2", true));
        p.event(&panes("spark2", vec![pane(1, "spark2", mode, None)]));
        p
    }

    /// The alert as the core would raise it: its attention state first.
    fn raise(p: &mut Policy, kind: AlertKind, now: Instant) -> Vec<Push> {
        let act = if kind == AlertKind::NeedsInput { Activity::NeedsInput } else { Activity::Idle };
        p.event(&activity(1, act));
        p.alert(&alert(1, kind, "spark2"), now, T0)
    }

    #[test]
    fn untracked_panes_never_push() {
        let mut p = setup(None);
        let t = Instant::now();
        assert!(raise(&mut p, AlertKind::Finished, t).is_empty());
        assert!(p.due(t + Duration::from_secs(3600)).is_empty());
        assert!(p.next_deadline().is_none());
    }

    #[test]
    fn waits_for_the_delay() {
        let mut p = setup(Some(NotifyMode::Delay));
        let t = Instant::now();
        assert!(raise(&mut p, AlertKind::Finished, t).is_empty(), "the default mode waits");
        assert_eq!(p.next_deadline(), Some(t + Duration::from_secs(180)));
        assert_eq!(p.pending(t + Duration::from_secs(30))[0].due_in_ms, 150_000);
        assert!(p.due(t + Duration::from_secs(179)).is_empty());
        let out = p.due(t + Duration::from_secs(180));
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].key, out[0].kind, out[0].tag.as_str()), (1, AlertKind::Finished, "pane:spark2/%1"));
        assert!(p.due(t + Duration::from_secs(400)).is_empty(), "one push per alert");

        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::NeedsInput, t);
        assert!(p.due(t + Duration::from_secs(59)).is_empty());
        assert_eq!(p.due(t + Duration::from_secs(60))[0].kind, AlertKind::NeedsInput);
    }

    #[test]
    fn going_back_to_work_cancels() {
        for back in [Activity::Working, Activity::Unknown] {
            let mut p = setup(Some(NotifyMode::Delay));
            let t = Instant::now();
            raise(&mut p, AlertKind::Finished, t);
            p.event(&activity(1, back));
            assert!(p.due(t + Duration::from_secs(600)).is_empty(), "{back:?}");
        }
    }

    #[test]
    fn untracking_or_losing_the_pane_cancels() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        p.event(&panes("spark2", vec![pane(1, "spark2", None, None)]));
        assert!(p.due(t + Duration::from_secs(600)).is_empty(), "untracked");

        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        p.event(&panes("spark2", vec![]));
        assert!(p.due(t + Duration::from_secs(600)).is_empty(), "pane closed");

        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        p.event(&CoreEvent::HostRemoved { id: "spark2".into() });
        assert!(p.due(t + Duration::from_secs(600)).is_empty(), "host removed");

        // Another host's pane list leaves this one alone.
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        p.event(&panes("mbas-macbook-pro", vec![]));
        assert_eq!(p.due(t + Duration::from_secs(600)).len(), 1);
    }

    #[test]
    fn seen_on_a_device_cancels() {
        let t = Instant::now();
        // Seen after the alert (or just before it, within the slack): no push.
        for seen in [T0 + 30, T0 - 5] {
            let mut p = setup(Some(NotifyMode::Delay));
            raise(&mut p, AlertKind::Finished, t);
            p.event(&panes("spark2", vec![pane(1, "spark2", Some(NotifyMode::Delay), Some(seen))]));
            assert!(p.due(t + Duration::from_secs(600)).is_empty(), "seen at {seen}");
        }
        // Seen well before it: that was an earlier turn.
        let mut p = setup(Some(NotifyMode::Delay));
        p.event(&panes("spark2", vec![pane(1, "spark2", Some(NotifyMode::Delay), Some(T0 - 300))]));
        raise(&mut p, AlertKind::Finished, t);
        assert_eq!(p.due(t + Duration::from_secs(600)).len(), 1);
        // The phone opened it.
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        p.seen(1);
        assert!(p.due(t + Duration::from_secs(600)).is_empty());
    }

    #[test]
    fn seen_in_an_earlier_turn_doesnt_count() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        // Seen while it waited, then you replied (back to work), then it asks again soon after.
        p.event(&panes("spark2", vec![pane(1, "spark2", Some(NotifyMode::Delay), Some(T0 - 6))]));
        p.event(&activity_at(1, Activity::Working, T0 - 4));
        p.event(&activity_at(1, Activity::NeedsInput, T0));
        p.alert(&alert(1, AlertKind::NeedsInput, "spark2"), t, T0);
        assert_eq!(p.due(t + Duration::from_secs(60)).len(), 1, "that seen was about the previous turn");
        // Seen after it went back to work (while it waits now): counts.
        let mut p = setup(Some(NotifyMode::Delay));
        p.event(&activity_at(1, Activity::Working, T0 - 4));
        p.event(&activity_at(1, Activity::NeedsInput, T0));
        p.alert(&alert(1, AlertKind::NeedsInput, "spark2"), t, T0);
        p.event(&panes("spark2", vec![pane(1, "spark2", Some(NotifyMode::Delay), Some(T0 + 1))]));
        assert!(p.due(t + Duration::from_secs(60)).is_empty());
    }

    #[test]
    fn unreachable_host_drops_the_push() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        p.event(&connected("spark2", false));
        assert!(p.due(t + Duration::from_secs(600)).is_empty());
        assert!(p.next_deadline().is_none(), "dropped, not put off");
    }

    #[test]
    fn a_newer_alert_replaces_the_pending_one() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        raise(&mut p, AlertKind::NeedsInput, t + Duration::from_secs(10));
        let out = p.due(t + Duration::from_secs(70));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, AlertKind::NeedsInput);
        assert!(p.due(t + Duration::from_secs(600)).is_empty());
    }

    #[test]
    fn turn_end_modes_push_after_a_short_grace() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Any));
        assert!(raise(&mut p, AlertKind::NeedsInput, t).is_empty());
        assert_eq!(p.due(t + GRACE).len(), 1, "a question, after the grace");
        assert!(raise(&mut p, AlertKind::Finished, t).is_empty());
        assert_eq!(p.due(t + GRACE).len(), 1);

        let mut p = setup(Some(NotifyMode::Finished));
        assert!(raise(&mut p, AlertKind::NeedsInput, t).is_empty());
        assert!(p.due(t + GRACE).is_empty() && p.next_deadline().is_none(), "no questions in finished-only mode");
        raise(&mut p, AlertKind::Finished, t);
        assert_eq!(p.due(t + GRACE).len(), 1);
    }

    #[test]
    fn a_desktop_showing_the_pane_cancels_a_turn_end_push() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Any));
        raise(&mut p, AlertKind::Finished, t);
        // The desktop marks it seen just after the alert.
        p.event(&panes("spark2", vec![pane(1, "spark2", Some(NotifyMode::Any), Some(T0 + 1))]));
        assert!(p.due(t + GRACE).is_empty());
    }

    #[test]
    fn settings_apply_to_pushes_already_waiting() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::Finished, t);
        assert!(p.due(t + Duration::from_secs(61)).is_empty(), "180 s at first");
        p.set_prefs(&NotifyPrefs { finished_secs: 60, ..Default::default() }, T0);
        assert_eq!(p.due(t + Duration::from_secs(61)).len(), 1, "60 s once changed");
    }

    #[test]
    fn a_mode_switch_applies_to_a_waiting_push() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::NeedsInput, t);
        p.event(&panes("spark2", vec![pane(1, "spark2", Some(NotifyMode::Finished), None)]));
        assert!(p.due(t + Duration::from_secs(61)).is_empty(), "finished-only: the question doesn't push");
        assert!(p.pending(t).is_empty());
    }

    #[test]
    fn a_pause_drops_and_refuses_pushes() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Delay));
        raise(&mut p, AlertKind::NeedsInput, t);
        p.set_prefs(&NotifyPrefs { paused_until: Some(T0 + 3600), ..Default::default() }, T0);
        assert!(p.pending(t).is_empty(), "what was waiting is dropped");
        assert!(raise(&mut p, AlertKind::NeedsInput, t).is_empty() && p.pending(t).is_empty(), "nothing new while paused");
        p.set_prefs(&NotifyPrefs::default(), T0);
        raise(&mut p, AlertKind::NeedsInput, t);
        assert_eq!(p.pending(t).len(), 1, "back on");
    }

    #[test]
    fn other_alerts_are_ignored() {
        let t = Instant::now();
        let mut p = setup(Some(NotifyMode::Any));
        p.event(&activity(1, Activity::Idle));
        for kind in [AlertKind::Bell, AlertKind::Subtask] {
            assert!(p.alert(&alert(1, kind, "spark2"), t, T0).is_empty());
        }
        let summary = Alert { key: None, kind: AlertKind::Summary, title: "2 agents".into(), body: String::new(), sound: true, toast: true, flash: true };
        assert!(p.alert(&summary, t, T0).is_empty(), "replays after a reconnect never burst");
    }

    #[test]
    fn local_panes_use_the_machines_name() {
        let t = Instant::now();
        let mut p = Policy::new(Delays::default());
        p.event(&CoreEvent::Tailnet {
            status: TailnetStatus {
                self_node: Some(TailnetPeer {
                    id: "spark-d683".into(),
                    host_name: "spark-d683".into(),
                    dns_name: "spark-d683.example.ts.net".into(),
                    os: "linux".into(),
                    ips: Vec::new(),
                    online: true,
                    ssh_host_keys: Vec::new(),
                    is_self: true,
                }),
                ..Default::default()
            },
        });
        p.event(&panes(LOCAL_HOST, vec![pane(7, LOCAL_HOST, Some(NotifyMode::Any), None)]));
        p.event(&activity(7, Activity::Idle));
        // No Host event for @local: it's always reachable.
        p.alert(&alert(7, AlertKind::Finished, LOCAL_HOST), t, T0);
        let out = p.due(t + GRACE);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].host, "spark-d683");
        assert_eq!(out[0].tag, "pane:spark-d683/%7");
        assert!(out[0].body.ends_with("Claude Code on spark-d683"), "{}", out[0].body);

        p.name_this_machine("the big one".into());
        p.alert(&alert(7, AlertKind::Finished, LOCAL_HOST), t, T0 + 60);
        let out = p.due(t + GRACE);
        assert_eq!(out[0].host, "the big one", "a given name wins over the tailnet's");
    }
}
