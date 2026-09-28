//! The attention state machine: turns harness hook events (and activity heuristics) into
//! per-pane state and alerts, applying the focus rules.
//!
//! - A pane that finishes / needs input while not expanded: ping, glow (Unacked) until the
//!   user interacts with it, then a "waiting on you" banner (Acked).
//! - The expanded pane: counts as seen immediately; pings only if the app isn't focused.
//! - Toasts and taskbar flashes only when the app window isn't focused.
//! - Subagent completions: a soft ping and a pulse, no state change.
//! - Events replayed after a reconnect are folded into one summary alert.

use std::collections::{HashMap, HashSet};

use crate::model::{Activity, Alert, AlertKind, AttentionLevel, FocusState, PaneAttention};

/// A harness lifecycle event (from our hook script's `events.jsonl`, or a heuristic).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signal {
    pub event: String,
    pub detail: String,
    /// Remote timestamp (unix seconds); used to spot stale replays.
    pub ts: u64,
    pub heuristic: bool,
}

#[derive(Debug, Clone)]
pub struct PaneLabel {
    pub title: String,
    pub harness: String,
    pub host: String,
}

enum Effect {
    State(Activity, Option<AlertKind>, String),
    Pulse,
    /// Terminal bell: flag the pane without touching its activity.
    Bell,
    Ignore,
}

/// At most one bell ping per pane in this many seconds (chat clients can ring in bursts).
const BELL_EVERY: f64 = 15.0;

fn classify(event: &str, detail: &str, current: Activity) -> Effect {
    match event {
        "UserPromptSubmit" => Effect::State(Activity::Working, None, "Working".into()),
        // A fresh session waits for its first prompt; don't ping for that.
        "SessionStart" => Effect::State(Activity::Idle, None, "Ready".into()),
        "Stop" => Effect::State(Activity::Idle, Some(AlertKind::Finished), "Finished — your turn".into()),
        "StopFailure" => Effect::State(Activity::Idle, Some(AlertKind::Finished), "Stopped with an error".into()),
        "PermissionRequest" => {
            let reason = if detail.is_empty() { "Needs permission".to_string() } else { format!("Needs permission: {detail}") };
            Effect::State(Activity::NeedsInput, Some(AlertKind::NeedsInput), reason)
        }
        "AskUserQuestion" => Effect::State(Activity::NeedsInput, Some(AlertKind::NeedsInput), "Has a question for you".into()),
        "Notification" => match detail {
            "permission_prompt" | "elicitation_dialog" | "agent_needs_input" if current != Activity::NeedsInput => {
                Effect::State(Activity::NeedsInput, Some(AlertKind::NeedsInput), "Needs your input".into())
            }
            "idle_prompt" if current == Activity::Working => {
                Effect::State(Activity::Idle, Some(AlertKind::Finished), "Waiting for you".into())
            }
            _ => Effect::Ignore,
        },
        "SubagentStop" => Effect::Pulse,
        "Bell" => Effect::Bell,
        "SessionEnd" => Effect::State(Activity::Unknown, None, "Session ended".into()),
        "HeuristicWorking" => Effect::State(Activity::Working, None, "Working".into()),
        "HeuristicIdle" if current == Activity::Working => {
            Effect::State(Activity::Idle, Some(AlertKind::Finished), "Went quiet — probably your turn".into())
        }
        _ => Effect::Ignore,
    }
}

#[derive(Default)]
pub struct AttentionBook {
    panes: HashMap<u32, PaneAttention>,
    /// Panes that have reported at least one real hook event (heuristics are ignored for them).
    hooked: HashSet<u32>,
    muted: HashSet<u32>,
    /// When each pane last pinged for a bell.
    bells: HashMap<u32, f64>,
    pub focus: FocusState,
}

pub struct Outcome {
    pub changed: Option<PaneAttention>,
    pub alert: Option<Alert>,
}

impl AttentionBook {
    pub fn get(&self, key: u32) -> Option<&PaneAttention> {
        self.panes.get(&key)
    }

    pub fn all(&self) -> Vec<PaneAttention> {
        self.panes.values().cloned().collect()
    }

    pub fn has_hooks(&self, key: u32) -> bool {
        self.hooked.contains(&key)
    }

    pub fn set_muted(&mut self, key: u32, muted: bool) {
        if muted {
            self.muted.insert(key);
        } else {
            self.muted.remove(&key);
        }
    }

    /// Applies a signal. `stale` suppresses the alert (the caller summarises replays).
    pub fn apply(&mut self, key: u32, sig: &Signal, label: &PaneLabel, now: f64, stale: bool) -> Outcome {
        if sig.heuristic && self.hooked.contains(&key) {
            return Outcome { changed: None, alert: None };
        }
        // Bells aren't hooks: they say nothing about whether the agent reports its turns.
        if !sig.heuristic && sig.event != "Bell" {
            self.hooked.insert(key);
        }
        let entry = self.panes.entry(key).or_insert_with(|| PaneAttention { key, source: "hook".into(), ..Default::default() });
        let source = if sig.heuristic { "heuristic" } else { "hook" };
        let expanded = self.focus.expanded == Some(key);
        let looking = expanded && self.focus.window_focused;
        let muted = self.muted.contains(&key);

        match classify(&sig.event, &sig.detail, entry.activity) {
            Effect::Ignore => Outcome { changed: None, alert: None },
            Effect::Bell => {
                if looking || self.bells.get(&key).is_some_and(|t| now - t < BELL_EVERY) {
                    return Outcome { changed: None, alert: None };
                }
                self.bells.insert(key, now);
                if !expanded {
                    entry.attention = AttentionLevel::Unacked;
                }
                entry.reason = Some("Rang the bell".into());
                entry.since = now;
                let unfocused = !self.focus.window_focused;
                let alert = (!stale && !muted).then(|| Alert {
                    key: Some(key),
                    kind: AlertKind::Bell,
                    title: format!("{} rang the bell", label.title),
                    body: format!("{} on {}", label.harness, label.host),
                    sound: true,
                    toast: unfocused,
                    flash: unfocused,
                });
                Outcome { changed: Some(entry.clone()), alert }
            }
            Effect::Pulse => {
                entry.pulse += 1;
                let alert = (!stale && !looking && !muted).then(|| Alert {
                    key: Some(key),
                    kind: AlertKind::Subtask,
                    title: format!("{} · subtask finished", label.title),
                    body: format!("A subagent in {} on {} finished.", label.harness, label.host),
                    sound: true,
                    toast: false,
                    flash: false,
                });
                Outcome { changed: Some(entry.clone()), alert }
            }
            Effect::State(activity, alert_kind, reason) => {
                entry.activity = activity;
                entry.reason = Some(reason.clone());
                entry.since = now;
                entry.source = source.into();
                entry.attention = match (activity, alert_kind) {
                    (Activity::Working | Activity::Unknown, _) => AttentionLevel::None,
                    (_, Some(_)) if expanded => AttentionLevel::Acked,
                    (_, Some(_)) => AttentionLevel::Unacked,
                    // Idle without an alert (session start): nothing to flag.
                    (_, None) => entry.attention,
                };
                let alert = alert_kind.filter(|_| !stale && !muted).and_then(|kind| {
                    // The user is looking right at it: no need to interrupt.
                    if looking {
                        return None;
                    }
                    let unfocused = !self.focus.window_focused;
                    Some(Alert {
                        key: Some(key),
                        kind,
                        title: match kind {
                            AlertKind::NeedsInput => format!("{} needs you", label.title),
                            _ => format!("{} is done", label.title),
                        },
                        body: format!("{reason} · {} on {}", label.harness, label.host),
                        sound: true,
                        toast: unfocused,
                        flash: unfocused,
                    })
                });
                Outcome { changed: Some(entry.clone()), alert }
            }
        }
    }

    /// The user interacted with the pane (clicked, expanded, typed into it).
    pub fn ack(&mut self, key: u32) -> Option<PaneAttention> {
        let e = self.panes.get_mut(&key)?;
        if e.attention == AttentionLevel::Unacked {
            e.attention = AttentionLevel::Acked;
            return Some(e.clone());
        }
        None
    }

    /// Updates focus; expanding a pane acknowledges it.
    pub fn set_focus(&mut self, focus: FocusState) -> Vec<PaneAttention> {
        self.focus = focus;
        focus.expanded.and_then(|k| self.ack(k)).into_iter().collect()
    }

    /// Forgets panes that no longer exist.
    pub fn retain(&mut self, alive: &HashSet<u32>) {
        self.panes.retain(|k, _| alive.contains(k));
        self.hooked.retain(|k| alive.contains(k));
        self.bells.retain(|k, _| alive.contains(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(event: &str) -> Signal {
        Signal { event: event.into(), detail: String::new(), ts: 0, heuristic: false }
    }
    fn label() -> PaneLabel {
        PaneLabel { title: "refactor".into(), harness: "Claude Code".into(), host: "spark2".into() }
    }

    #[test]
    fn collapsed_pane_glows_then_banner() {
        let mut b = AttentionBook::default();
        b.set_focus(FocusState { expanded: None, window_focused: true });
        b.apply(1, &sig("UserPromptSubmit"), &label(), 1.0, false);
        let out = b.apply(1, &sig("Stop"), &label(), 2.0, false);
        let st = out.changed.unwrap();
        assert_eq!((st.activity, st.attention), (Activity::Idle, AttentionLevel::Unacked));
        let alert = out.alert.unwrap();
        assert!(alert.sound && !alert.toast && !alert.flash, "focused app: ping, no toast");
        assert_eq!(b.ack(1).unwrap().attention, AttentionLevel::Acked);
        // Next prompt clears it.
        let st = b.apply(1, &sig("UserPromptSubmit"), &label(), 3.0, false).changed.unwrap();
        assert_eq!(st.attention, AttentionLevel::None);
    }

    #[test]
    fn expanded_pane_rules() {
        let mut b = AttentionBook::default();
        b.set_focus(FocusState { expanded: Some(1), window_focused: true });
        let out = b.apply(1, &sig("Stop"), &label(), 1.0, false);
        assert_eq!(out.changed.unwrap().attention, AttentionLevel::Acked);
        assert!(out.alert.is_none(), "looking at it: silent");

        b.set_focus(FocusState { expanded: Some(1), window_focused: false });
        let out = b.apply(1, &sig("PermissionRequest"), &label(), 2.0, false);
        assert_eq!(out.changed.unwrap().attention, AttentionLevel::Acked, "expanded counts as interacted");
        let a = out.alert.unwrap();
        assert!(a.sound && a.toast && a.flash, "app unfocused: ping + toast + flash");
        assert_eq!(a.kind, AlertKind::NeedsInput);
    }

    #[test]
    fn expanding_acks() {
        let mut b = AttentionBook::default();
        b.apply(4, &sig("Stop"), &label(), 1.0, false);
        let changed = b.set_focus(FocusState { expanded: Some(4), window_focused: true });
        assert_eq!(changed[0].attention, AttentionLevel::Acked);
    }

    #[test]
    fn subagent_pulses_softly() {
        let mut b = AttentionBook::default();
        b.apply(1, &sig("UserPromptSubmit"), &label(), 1.0, false);
        let out = b.apply(1, &sig("SubagentStop"), &label(), 2.0, false);
        let st = out.changed.unwrap();
        assert_eq!((st.activity, st.pulse), (Activity::Working, 1));
        let a = out.alert.unwrap();
        assert!(a.sound && !a.toast);
    }

    #[test]
    fn stale_and_muted_are_silent_but_update_state() {
        let mut b = AttentionBook::default();
        let out = b.apply(1, &sig("Stop"), &label(), 1.0, true);
        assert!(out.alert.is_none());
        assert_eq!(out.changed.unwrap().attention, AttentionLevel::Unacked);
        b.set_muted(2, true);
        assert!(b.apply(2, &sig("Stop"), &label(), 1.0, false).alert.is_none());
    }

    #[test]
    fn bells_glow_once_per_window_and_leave_activity_alone() {
        let mut b = AttentionBook::default();
        let bell = sig("Bell");
        b.apply(1, &sig("UserPromptSubmit"), &label(), 0.0, false);
        let o = b.apply(1, &bell, &label(), 10.0, false);
        let st = o.changed.unwrap();
        assert_eq!((st.activity, st.attention), (Activity::Working, AttentionLevel::Unacked));
        assert_eq!(o.alert.unwrap().kind, AlertKind::Bell);
        // A burst within 15 s stays quiet.
        let o = b.apply(1, &bell, &label(), 20.0, false);
        assert!(o.alert.is_none() && o.changed.is_none());
        assert!(b.apply(1, &bell, &label(), 26.0, false).alert.is_some());
        // Looking right at it: nothing.
        b.set_focus(FocusState { expanded: Some(2), window_focused: true });
        assert!(b.apply(2, &bell, &label(), 30.0, false).alert.is_none());
        // Bells don't count as hooks (heuristics keep working).
        assert!(!b.has_hooks(3));
        b.apply(3, &bell, &label(), 0.0, false);
        assert!(!b.has_hooks(3));
    }

    #[test]
    fn heuristics_yield_to_hooks() {
        let mut b = AttentionBook::default();
        let h = |e: &str| Signal { event: e.into(), detail: String::new(), ts: 0, heuristic: true };
        b.apply(1, &h("HeuristicWorking"), &label(), 1.0, false);
        let out = b.apply(1, &h("HeuristicIdle"), &label(), 2.0, false);
        assert_eq!(out.changed.unwrap().source, "heuristic");
        b.apply(1, &sig("UserPromptSubmit"), &label(), 3.0, false);
        assert!(b.apply(1, &h("HeuristicIdle"), &label(), 4.0, false).changed.is_none());
    }

    #[test]
    fn idle_prompt_only_fires_after_work() {
        let mut b = AttentionBook::default();
        let n = Signal { event: "Notification".into(), detail: "idle_prompt".into(), ts: 0, heuristic: false };
        assert!(b.apply(1, &n, &label(), 1.0, false).changed.is_none());
    }
}
