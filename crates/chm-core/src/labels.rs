//! Label definitions, shared between devices through the machines.
//!
//! Every connected tmux server holds the merged set in the global user option
//! `@chm_label_defs`; each core keeps its own copy in config.json (`AppConfig.labels`: the live
//! labels in order; `AppConfig.label_sync`: tombstones and the order's time), so labels are
//! there before any machine connects and go back to a tmux server that restarted.
//!
//! - Per label, the newest `updated` wins. A delete is a tombstone with its own time, kept for
//!   [`TOMBSTONE_DAYS`] so every device hears of it.
//! - The order is one value with its own time: the newest wins. Labels it doesn't list (made
//!   on another device meanwhile) follow it, by id.
//! - Ties are broken by content, so merging is commutative, associative and idempotent: devices
//!   end up with the same set whatever order they learn things in, and nothing is written back
//!   to a machine that already agrees.
//! - An edit is timed after what it replaces, so it wins even on a device whose clock is behind.
//!
//! The option's value is `<stamp><base64url JSON>`, the stamp being 16 hex digits of FNV-1a over
//! the rest: no `|~|`, quotes or `#` to upset formats, and a subscription can carry just the
//! stamp (`#{=16:@chm_label_defs}`) and still notice every change.

use std::collections::{BTreeMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use crate::model::{LabelDef, LabelSync, label_slug};

/// The tmux global user option holding the shared definitions.
pub const OPTION: &str = "@chm_label_defs";
/// Length of the value's leading stamp.
pub const STAMP_LEN: usize = 16;
/// How long a delete is remembered.
pub const TOMBSTONE_DAYS: u64 = 30;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// The value's format; a newer one is neither read nor overwritten.
const VERSION: u32 = 1;

/// One label as shared: a definition, or the tombstone of a deleted one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// When it was created, renamed, recoloured or deleted (unix ms).
    #[serde(default)]
    pub updated: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

impl Entry {
    /// Which of two versions wins: the newer, then a delete, then by content.
    fn rank(&self) -> (u64, bool, &str, &str) {
        (self.updated, self.deleted, &self.name, &self.color)
    }
}

/// Every label a device knows of, with the order the user gave them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LabelSet {
    pub labels: BTreeMap<String, Entry>,
    pub order: Vec<String>,
    /// When the order was set (unix ms).
    pub order_updated: u64,
}

#[derive(Serialize)]
struct WireOut<'a> {
    v: u32,
    #[serde(flatten)]
    set: &'a LabelSet,
}

#[derive(Deserialize)]
struct WireIn {
    v: u32,
    #[serde(flatten)]
    set: LabelSet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// The option isn't set.
    Empty,
    /// Not something we wrote (or cut short).
    Invalid,
    /// A newer app's format: left alone.
    Newer,
}

/// Unix time in ms.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A time for an edit: now, or just after the version it replaces.
fn after(now: u64, prev: u64) -> u64 {
    now.max(prev.saturating_add(1))
}

fn fnv_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// What a subscription to the option shows: its first [`STAMP_LEN`] characters.
pub fn stamp(raw: &str) -> &str {
    let raw = raw.trim();
    raw.get(..STAMP_LEN).unwrap_or(raw)
}

/// Ids are slugs; anything else (a comma would break `@chm_labels`) is dropped.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn decode(raw: &str) -> Result<LabelSet, DecodeError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(DecodeError::Empty);
    }
    let (Some(stamp), Some(body)) = (raw.get(..STAMP_LEN), raw.get(STAMP_LEN..)) else { return Err(DecodeError::Invalid) };
    if stamp != fnv_hex(body) {
        return Err(DecodeError::Invalid);
    }
    let json = URL_SAFE_NO_PAD.decode(body).map_err(|_| DecodeError::Invalid)?;
    #[derive(Deserialize)]
    struct Head {
        v: u32,
    }
    let head: Head = serde_json::from_slice(&json).map_err(|_| DecodeError::Invalid)?;
    if head.v > VERSION {
        return Err(DecodeError::Newer);
    }
    let wire: WireIn = serde_json::from_slice(&json).map_err(|_| DecodeError::Invalid)?;
    debug_assert!(wire.v <= VERSION);
    let mut set = wire.set;
    set.labels.retain(|id, e| valid_id(id) && (e.deleted || !e.name.trim().is_empty()));
    set.order.retain(|id| valid_id(id));
    Ok(set)
}

/// Whether a machine holding `host` (the option's raw value) should be given `ours`, which
/// already has `host` merged in. Tombstones about to expire don't count, so devices whose
/// clocks disagree a little don't take turns adding and removing them.
pub fn needs_write(host: &str, ours: &LabelSet, now: u64) -> bool {
    match decode(host) {
        Ok(theirs) => theirs.pruned(now + DAY_MS) != ours.clone().pruned(now + DAY_MS),
        Err(DecodeError::Newer) => false,
        Err(DecodeError::Empty | DecodeError::Invalid) => !ours.is_empty(),
    }
}

impl LabelSet {
    /// What a config holds. Configs from before labels were shared have no order of their own:
    /// the list's order is it (time 0, so any order set since wins).
    pub fn from_config(labels: &[LabelDef], sync: &LabelSync) -> Self {
        let mut set = LabelSet::default();
        for l in labels {
            set.put(l.id.clone(), Entry { name: l.name.clone(), color: l.color.clone(), updated: l.updated, deleted: false });
        }
        for (id, at) in &sync.deleted {
            set.put(id.clone(), Entry { name: String::new(), color: String::new(), updated: *at, deleted: true });
        }
        if sync.order.is_empty() && sync.order_updated == 0 {
            set.order = labels.iter().map(|l| l.id.clone()).collect();
        } else {
            set.order = sync.order.clone();
            set.order_updated = sync.order_updated;
        }
        set
    }

    /// The config's view: live labels in order, and the rest.
    pub fn to_config(&self) -> (Vec<LabelDef>, LabelSync) {
        let deleted = self.labels.iter().filter(|(_, e)| e.deleted).map(|(id, e)| (id.clone(), e.updated)).collect();
        (self.live(), LabelSync { deleted, order: self.order.clone(), order_updated: self.order_updated })
    }

    /// Keeps whichever version of `id` wins.
    fn put(&mut self, id: String, entry: Entry) {
        match self.labels.get(&id) {
            Some(have) if have.rank() >= entry.rank() => {}
            _ => {
                self.labels.insert(id, entry);
            }
        }
    }

    /// Nothing to share: no labels, no tombstones, no order ever set.
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty() && self.order.is_empty() && self.order_updated == 0
    }

    /// The labels in use, in order: the order's, then any it doesn't list, by id.
    pub fn live(&self) -> Vec<LabelDef> {
        let def = |id: &str, e: &Entry| LabelDef { id: id.to_string(), name: e.name.clone(), color: e.color.clone(), updated: e.updated };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for id in &self.order {
            if let Some(e) = self.labels.get(id)
                && !e.deleted
                && seen.insert(id.as_str())
            {
                out.push(def(id, e));
            }
        }
        out.extend(self.labels.iter().filter(|(id, e)| !e.deleted && !seen.contains(id.as_str())).map(|(id, e)| def(id, e)));
        out
    }

    fn live_ids(&self) -> Vec<String> {
        self.live().into_iter().map(|l| l.id).collect()
    }

    /// Both sets' knowledge in one.
    pub fn merge(&self, other: &LabelSet) -> LabelSet {
        let mut out = self.clone();
        for (id, e) in &other.labels {
            out.put(id.clone(), e.clone());
        }
        if (other.order_updated, &other.order) > (self.order_updated, &self.order) {
            out.order = other.order.clone();
            out.order_updated = other.order_updated;
        }
        out
    }

    /// Without tombstones older than [`TOMBSTONE_DAYS`] at `now`.
    pub fn pruned(mut self, now: u64) -> LabelSet {
        let keep = TOMBSTONE_DAYS * DAY_MS;
        self.labels.retain(|_, e| !e.deleted || e.updated.saturating_add(keep) >= now);
        self
    }

    /// A new label (its id from the name, unique among the live ones), last in the order.
    pub fn create(&mut self, name: &str, color: &str, now: u64) -> LabelDef {
        let base = label_slug(name);
        let mut id = base.clone();
        let mut n = 2;
        while self.labels.get(&id).is_some_and(|e| !e.deleted) {
            id = format!("{base}-{n}");
            n += 1;
        }
        // Reusing a deleted label's id brings it back: newer than its tombstone.
        let updated = after(now, self.labels.get(&id).map_or(0, |e| e.updated));
        let mut order = self.live_ids();
        order.push(id.clone());
        let entry = Entry { name: name.trim().to_string(), color: color.to_string(), updated, deleted: false };
        self.labels.insert(id.clone(), entry);
        self.order = order;
        self.order_updated = after(now, self.order_updated);
        LabelDef { id, name: name.trim().to_string(), color: color.to_string(), updated }
    }

    /// Renames/recolours a live label. False if there was nothing to change.
    pub fn update(&mut self, id: &str, name: &str, color: &str, now: u64) -> bool {
        let name = name.trim();
        match self.labels.get_mut(id) {
            Some(e) if !e.deleted && !name.is_empty() && (e.name != name || e.color != color) => {
                e.name = name.to_string();
                e.color = color.to_string();
                e.updated = after(now, e.updated);
                true
            }
            _ => false,
        }
    }

    /// Replaces a live label with its tombstone.
    pub fn delete(&mut self, id: &str, now: u64) -> bool {
        match self.labels.get_mut(id) {
            Some(e) if !e.deleted => {
                *e = Entry { name: String::new(), color: String::new(), updated: after(now, e.updated), deleted: true };
                true
            }
            _ => false,
        }
    }

    /// Puts the live labels in the order of `ids`; ones it leaves out keep their places after.
    pub fn reorder(&mut self, ids: &[String], now: u64) -> bool {
        let current = self.live_ids();
        let mut order: Vec<String> = Vec::new();
        for id in ids {
            if current.contains(id) && !order.contains(id) {
                order.push(id.clone());
            }
        }
        for id in current.iter() {
            if !order.contains(id) {
                order.push(id.clone());
            }
        }
        if order == current {
            return false;
        }
        self.order = order;
        self.order_updated = after(now, self.order_updated);
        true
    }

    /// The option's value for this set (the same set always gives the same value).
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(&WireOut { v: VERSION, set: self }).expect("labels serialise");
        let body = URL_SAFE_NO_PAD.encode(json);
        format!("{}{body}", fnv_hex(&body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_800_000_000_000;

    fn names(set: &LabelSet) -> Vec<String> {
        set.live().into_iter().map(|l| l.name).collect()
    }

    fn base() -> LabelSet {
        let mut s = LabelSet::default();
        s.create("Work", "#111", T);
        s.create("Home", "#222", T + 1);
        s.create("Urgent", "#333", T + 2);
        s
    }

    #[test]
    fn create_update_delete_reorder() {
        let mut s = base();
        assert_eq!(names(&s), ["Work", "Home", "Urgent"]);
        assert_eq!(s.create("work", "#444", T + 3).id, "work-2");
        assert!(s.update("home", "House", "#222", T + 4));
        assert!(!s.update("home", "House", "#222", T + 5), "nothing changed");
        assert!(!s.update("home", "  ", "#222", T + 5), "a blank name is refused");
        assert!(s.reorder(&["urgent".into(), "work".into()], T + 6));
        assert_eq!(names(&s), ["Urgent", "Work", "House", "work"]);
        assert!(!s.reorder(&["urgent".into()], T + 7), "already in that order");
        assert!(s.delete("work", T + 8));
        assert!(!s.delete("work", T + 9));
        assert_eq!(names(&s), ["Urgent", "House", "work"]);
        assert!(s.labels["work"].deleted);
        // A new label with a deleted one's id brings it back, newer than its tombstone.
        let back = s.create("Work", "#555", T);
        assert_eq!(back.id, "work");
        assert!(back.updated > T + 8);
        assert_eq!(names(&s), ["Urgent", "House", "work", "Work"]);
    }

    #[test]
    fn edits_win_over_what_they_replace_even_with_a_slow_clock() {
        let mut s = base();
        s.update("work", "Job", "#111", T + 100);
        // This device's clock is a minute behind the one that renamed it.
        assert!(s.update("work", "Office", "#111", T + 40));
        assert_eq!(s.labels["work"].updated, T + 101);
        assert!(s.reorder(&["urgent".into()], T));
        assert!(s.order_updated > T + 2);
    }

    #[test]
    fn merge_is_commutative_associative_idempotent() {
        let mut a = base();
        let mut b = base();
        let mut c = base();
        a.update("work", "Job", "#111", T + 10);
        b.update("work", "Office", "#999", T + 11);
        b.delete("home", T + 12);
        c.reorder(&["urgent".into(), "home".into()], T + 13);
        c.create("Later", "#777", T + 14);
        a.create("Later", "#778", T + 14);
        assert_eq!(a.merge(&b), b.merge(&a));
        assert_eq!(a.merge(&b).merge(&c), a.merge(&b.merge(&c)));
        assert_eq!(a.merge(&c).merge(&b), c.merge(&b).merge(&a));
        let m = a.merge(&b).merge(&c);
        assert_eq!(m.merge(&m), m);
        assert_eq!(m.merge(&a), m);
        // Both made "Later" at the same time: decided by content, the same way everywhere (the
        // order too).
        assert_eq!(names(&m), ["Office", "Urgent", "Later"]);
        assert_eq!(m.labels["later"].color, "#778");
    }

    #[test]
    fn concurrent_edits_newest_wins() {
        let start = base();
        let (mut a, mut b) = (start.clone(), start.clone());
        a.update("work", "Job", "#111", T + 50);
        b.update("work", "Office", "#111", T + 60);
        a.update("home", "House", "#222", T + 70);
        let m = a.merge(&b);
        assert_eq!(names(&m), ["Office", "House", "Urgent"]);
    }

    #[test]
    fn delete_versus_rename() {
        let start = base();
        // Deleted after the rename: stays deleted.
        let (mut a, mut b) = (start.clone(), start.clone());
        a.update("home", "House", "#222", T + 10);
        b.delete("home", T + 20);
        assert_eq!(names(&a.merge(&b)), ["Work", "Urgent"]);
        // Renamed after the delete (on a device that hadn't heard of it): back, renamed.
        let (mut a, mut b) = (start.clone(), start);
        a.delete("home", T + 10);
        b.update("home", "House", "#222", T + 20);
        assert_eq!(names(&a.merge(&b)), ["Work", "House", "Urgent"]);
        assert_eq!(names(&b.merge(&a)), ["Work", "House", "Urgent"]);
    }

    #[test]
    fn order_conflicts() {
        let start = base();
        let (mut a, mut b) = (start.clone(), start.clone());
        a.reorder(&["urgent".into(), "home".into(), "work".into()], T + 10);
        b.reorder(&["home".into(), "work".into(), "urgent".into()], T + 20);
        assert_eq!(names(&a.merge(&b)), ["Home", "Work", "Urgent"]);
        assert_eq!(names(&b.merge(&a)), ["Home", "Work", "Urgent"]);
        // A label made elsewhere meanwhile, missing from the winning order, follows it.
        let mut c = start;
        c.create("Alpha", "#000", T + 5);
        assert_eq!(names(&c.merge(&b)), ["Home", "Work", "Urgent", "Alpha"]);
        // Same time, different orders: decided by content.
        let (mut x, mut y) = (base(), base());
        x.order = vec!["home".into(), "work".into(), "urgent".into()];
        y.order = vec!["work".into(), "urgent".into(), "home".into()];
        x.order_updated = T + 30;
        y.order_updated = T + 30;
        assert_eq!(x.merge(&y), y.merge(&x));
        assert_eq!(names(&x.merge(&y)), ["Work", "Urgent", "Home"]);
    }

    #[test]
    fn tombstones_expire() {
        let mut s = base();
        s.delete("home", T);
        let day = 24 * 60 * 60 * 1000;
        assert!(s.clone().pruned(T + 29 * day).labels.contains_key("home"));
        assert!(!s.clone().pruned(T + 31 * day).labels.contains_key("home"));
        assert_eq!(names(&s.clone().pruned(T + 31 * day)), ["Work", "Urgent"]);
    }

    #[test]
    fn encoding_round_trips_and_rejects_junk() {
        let mut s = base();
        s.delete("home", T + 5);
        let raw = s.encode();
        assert_eq!(raw, s.encode(), "deterministic");
        assert!(raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{raw}");
        assert_eq!(decode(&raw), Ok(s.clone()));
        assert_eq!(decode(&format!("{raw}\n")), Ok(s.clone()));
        assert_eq!(stamp(&raw).len(), STAMP_LEN);
        assert_eq!(decode(""), Err(DecodeError::Empty));
        assert_eq!(decode("hello"), Err(DecodeError::Invalid));
        assert_eq!(decode(&raw[..raw.len() - 3]), Err(DecodeError::Invalid), "cut short");
        let mut other = s.clone();
        other.update("work", "Job", "#111", T + 9);
        assert_ne!(stamp(&other.encode()), stamp(&raw), "the stamp shows every change");
        // A newer format is left alone.
        let body = URL_SAFE_NO_PAD.encode(br#"{"v":2,"labels":{}}"#);
        let newer = format!("{}{body}", fnv_hex(&body));
        assert_eq!(decode(&newer), Err(DecodeError::Newer));
        assert!(!needs_write(&newer, &s, T));
        // Junk ids (a comma would split `@chm_labels`) are dropped.
        let body = URL_SAFE_NO_PAD.encode(br#"{"v":1,"labels":{"a,b":{"name":"x","updated":1},"ok":{"name":"Ok","updated":1}},"order":["a,b","ok"]}"#);
        let junk = decode(&format!("{}{body}", fnv_hex(&body))).unwrap();
        assert_eq!(junk.labels.keys().collect::<Vec<_>>(), ["ok"]);
        assert_eq!(junk.order, ["ok"]);
    }

    #[test]
    fn writes_only_when_the_machine_disagrees() {
        let s = base();
        assert!(needs_write("", &s, T), "unset");
        assert!(needs_write("junk", &s, T));
        assert!(!needs_write("", &LabelSet::default(), T), "nothing to share");
        assert!(!needs_write(&s.encode(), &s, T));
        let mut newer = s.clone();
        newer.update("work", "Job", "#111", T + 9);
        assert!(needs_write(&s.encode(), &newer, T));
        // A tombstone one device has just let go of and another still keeps: no back and forth.
        let day = 24 * 60 * 60 * 1000;
        let mut d = s.clone();
        d.delete("home", T);
        let kept = d.clone().pruned(T + 30 * day - 60_000);
        let dropped = d.pruned(T + 30 * day + 60_000);
        assert_ne!(kept, dropped);
        assert!(!needs_write(&kept.encode(), &dropped, T + 30 * day + 60_000));
        assert!(!needs_write(&dropped.encode(), &kept, T + 30 * day - 60_000));
    }

    #[test]
    fn old_configs_migrate() {
        // config.json from before labels were shared: no times, no `labelSync`.
        let cfg: crate::model::AppConfig = serde_json::from_str(
            r##"{ "labels": [ { "id": "terrarium", "name": "terrarium", "color": "#4ade9a" }, { "id": "urgent", "name": "urgent", "color": "#ff6b81" } ] }"##,
        )
        .unwrap();
        assert_eq!(cfg.labels[0].updated, 0);
        let s = LabelSet::from_config(&cfg.labels, &cfg.label_sync);
        assert_eq!(names(&s), ["terrarium", "urgent"]);
        assert_eq!(s.order_updated, 0);
        // Any edit elsewhere beats them, and another device's old labels join them.
        let mut other = LabelSet::default();
        other.create("Work", "#111", T);
        other.update("work", "Work", "#112", T + 1);
        let m = s.merge(&other);
        assert_eq!(names(&m), ["Work", "terrarium", "urgent"], "the newer order first, then the rest by id");
        // Saved and loaded again, nothing is lost.
        let (labels, sync) = m.to_config();
        assert_eq!(LabelSet::from_config(&labels, &sync), m);
        let mut gone = m.clone();
        gone.delete("urgent", T + 5);
        let (labels, sync) = gone.to_config();
        assert_eq!(labels.len(), 2);
        assert_eq!(LabelSet::from_config(&labels, &sync), gone);
    }

    #[test]
    fn devices_converge_through_machines() {
        // Two devices and two machines; each device writes what it knows to the machines it
        // reaches, and merges what it finds there, until nobody has anything to write.
        let mut devices = [base(), LabelSet::default()];
        devices[1].create("Phone", "#abc", T + 3);
        devices[0].update("home", "House", "#222", T + 4);
        devices[1].reorder(&["phone".into()], T + 5);
        let mut machines = [String::new(), String::new()];
        let reach = [[true, false], [true, true]];
        for round in 0..5 {
            let mut wrote = false;
            for (d, device) in devices.iter_mut().enumerate() {
                for (m, value) in machines.iter_mut().enumerate() {
                    if !reach[d][m] {
                        continue;
                    }
                    if let Ok(theirs) = decode(value) {
                        *device = device.merge(&theirs);
                    }
                    if needs_write(value, device, T + 10) {
                        *value = device.encode();
                        wrote = true;
                    }
                }
            }
            if !wrote {
                assert!(round <= 2, "settled in round {round}");
                break;
            }
        }
        assert_eq!(devices[0], devices[1]);
        assert_eq!(machines[0], machines[1]);
        // The phone's order (it only knew its own label) is the newest; the rest follow by id.
        assert_eq!(names(&devices[0]), ["Phone", "House", "Urgent", "Work"]);
    }
}
