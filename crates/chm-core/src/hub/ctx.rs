//! State shared by the core and every host actor.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use super::attention::{AttentionBook, PaneLabel, Signal};
use crate::model::{Alert, CoreEvent, FocusState, HostFacts, HostId, HostPhase, HostState, NoticeLevel, PaneInfo, TailnetStatus};
use crate::ssh::hostkeys::KnownHosts;

/// Where the core pushes everything the UI needs.
pub trait Sink: Send + Sync + 'static {
    fn event(&self, event: CoreEvent);
    /// One encoded frame (see [`super::frames`]).
    fn frame(&self, frame: Vec<u8>);
    /// Surface a notification (sound / toast / taskbar flash).
    fn alert(&self, _alert: Alert) {}
}

/// (host, tmux server start time, tmux pane id) → app-wide pane key, plus the next key.
type PaneKeys = (HashMap<(HostId, u64, u32), u32>, u32);

pub(crate) struct Ctx {
    pub sink: Arc<dyn Sink>,
    pub known_hosts: Arc<KnownHosts>,
    pub tailnet: RwLock<TailnetStatus>,
    pub host_states: Mutex<BTreeMap<HostId, HostState>>,
    pub panes: Mutex<BTreeMap<HostId, Vec<PaneInfo>>>,
    /// Pane keys the UI currently shows; `None` means "all".
    pub visible: RwLock<Option<HashSet<u32>>>,
    pane_keys: Mutex<PaneKeys>,
    pub attention: Mutex<AttentionBook>,
    /// Panes the UI has expanded; survives reconnects so the expanded view resumes.
    pub streaming: Mutex<HashSet<u32>>,
}

impl Ctx {
    pub fn new(sink: Arc<dyn Sink>, known_hosts: Arc<KnownHosts>) -> Self {
        Self {
            sink,
            known_hosts,
            tailnet: RwLock::new(TailnetStatus::default()),
            host_states: Mutex::new(BTreeMap::new()),
            panes: Mutex::new(BTreeMap::new()),
            visible: RwLock::new(None),
            pane_keys: Mutex::new((HashMap::new(), 1)),
            attention: Mutex::new(AttentionBook::default()),
            streaming: Mutex::new(HashSet::new()),
        }
    }

    pub fn emit(&self, event: CoreEvent) {
        self.sink.event(event);
    }

    pub fn notice(&self, host: Option<&str>, level: NoticeLevel, message: impl Into<String>) {
        self.emit(CoreEvent::Notice { host: host.map(str::to_string), level, message: message.into() });
    }

    fn update_host(&self, id: &str, f: impl FnOnce(&mut HostState)) {
        let state = {
            let mut states = self.host_states.lock().unwrap();
            let entry = states.entry(id.to_string()).or_insert_with(|| HostState {
                id: id.to_string(),
                phase: HostPhase::Disconnected,
                facts: None,
            });
            let before = entry.clone();
            f(entry);
            if *entry == before {
                return;
            }
            entry.clone()
        };
        self.emit(CoreEvent::Host { state });
    }

    pub fn set_phase(&self, id: &str, phase: HostPhase) {
        self.update_host(id, |s| s.phase = phase);
    }

    pub fn set_facts(&self, id: &str, facts: Option<HostFacts>) {
        self.update_host(id, |s| s.facts = facts);
    }

    pub fn remove_host(&self, id: &str) {
        self.host_states.lock().unwrap().remove(id);
        self.set_panes(id, Vec::new());
        self.emit(CoreEvent::HostRemoved { id: id.to_string() });
    }

    pub fn set_panes(&self, host: &str, panes: Vec<PaneInfo>) {
        {
            let mut all = self.panes.lock().unwrap();
            if all.get(host) == Some(&panes) {
                return;
            }
            all.insert(host.to_string(), panes.clone());
            let alive: HashSet<u32> = all.values().flatten().map(|p| p.key).collect();
            self.attention.lock().unwrap().retain(&alive);
        }
        self.emit(CoreEvent::Panes { host: host.to_string(), panes });
    }

    /// Stable numeric key for a pane; changes if the tmux server restarts (ids get reused).
    pub fn pane_key(&self, host: &str, server_start: u64, pane: u32) -> u32 {
        let mut guard = self.pane_keys.lock().unwrap();
        let (map, next) = &mut *guard;
        *map.entry((host.to_string(), server_start, pane)).or_insert_with(|| {
            let k = *next;
            *next += 1;
            k
        })
    }

    /// Feeds a harness event into the attention book; emits the new state and any alert.
    pub fn signal(&self, key: u32, sig: &Signal, label: &PaneLabel, stale: bool) -> bool {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let outcome = self.attention.lock().unwrap().apply(key, sig, label, now, stale);
        let alerted = outcome.alert.is_some();
        if let Some(state) = outcome.changed {
            self.emit(CoreEvent::Attention { state });
        }
        if let Some(alert) = outcome.alert {
            self.sink.alert(alert);
        }
        alerted
    }

    pub fn ack(&self, key: u32) {
        if let Some(state) = self.attention.lock().unwrap().ack(key) {
            self.emit(CoreEvent::Attention { state });
        }
    }

    pub fn set_focus(&self, focus: FocusState) {
        let changed = self.attention.lock().unwrap().set_focus(focus);
        for state in changed {
            self.emit(CoreEvent::Attention { state });
        }
    }

    pub fn is_visible(&self, key: u32) -> bool {
        match &*self.visible.read().unwrap() {
            None => true,
            Some(set) => set.contains(&key),
        }
    }
}
