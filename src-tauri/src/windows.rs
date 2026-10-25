//! The app's windows: "main" (from tauri.conf.json) and the ones opened from the menu ("win-2",
//! "win-3", …), each with its own layout. Each window streams its own panes (raw output goes only
//! where it's wanted, tiles everywhere) and reports what it shows; the core gets one focus merged
//! from all of them. Extra windows open again at the next launch.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use chm_core::hub::frames;
use chm_core::model::FocusState;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::AppState;

pub const MAIN: &str = "main";
/// The extra windows, kept in the UI state to open them again at the next launch.
const SAVED: &str = "consuls.windows.v1";

#[derive(Default)]
struct Outlet {
    channel: Option<Channel<InvokeResponseBody>>,
    streams: HashSet<u32>,
}

#[derive(Default, Clone)]
struct View {
    focus: FocusState,
    /// What its layout shows (`pane:<identity>` / `file:<id>`), for hotkeys that jump across windows.
    targets: Vec<String>,
}

/// What a window shows, as the UI hears it (`window-views`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WindowView {
    pub label: String,
    pub targets: Vec<String>,
}

#[derive(Default)]
pub struct Windows {
    outlets: Mutex<BTreeMap<String, Outlet>>,
    views: Mutex<BTreeMap<String, View>>,
    last_focused: Mutex<Option<String>>,
}

impl Windows {
    /// The window's frames go to `channel` from now on. Streams it held before (it reloaded) are
    /// dropped; returns the ones no other window streams, for the core to stop.
    pub fn subscribe(&self, label: &str, channel: Channel<InvokeResponseBody>) -> Vec<u32> {
        let mut outlets = self.outlets.lock().unwrap();
        let outlet = outlets.entry(label.to_string()).or_default();
        outlet.channel = Some(channel);
        let held = std::mem::take(&mut outlet.streams);
        held.into_iter().filter(|k| !outlets.values().any(|o| o.streams.contains(k))).collect()
    }

    /// A window starts or stops streaming `key`. Returns whether the core should hear of it:
    /// always when starting (it re-seeds, and the new view needs that), and when stopping only
    /// if no other window streams the pane.
    pub fn stream(&self, label: &str, key: u32, on: bool) -> bool {
        let mut outlets = self.outlets.lock().unwrap();
        let outlet = outlets.entry(label.to_string()).or_default();
        if on {
            outlet.streams.insert(key);
            return true;
        }
        outlet.streams.remove(&key);
        !outlets.values().any(|o| o.streams.contains(&key))
    }

    /// The window is gone: forgets it, and returns its streams no other window wants.
    pub fn remove(&self, label: &str) -> Vec<u32> {
        self.views.lock().unwrap().remove(label);
        let mut last = self.last_focused.lock().unwrap();
        if last.as_deref() == Some(label) {
            *last = None;
        }
        let mut outlets = self.outlets.lock().unwrap();
        let held = outlets.remove(label).map(|o| o.streams).unwrap_or_default();
        held.into_iter().filter(|k| !outlets.values().any(|o| o.streams.contains(k))).collect()
    }

    /// Sends a batch of frames to every window: tiles to all, raw output to those streaming it.
    pub fn send(&self, batch: Vec<u8>) {
        let outlets = self.outlets.lock().unwrap();
        let mut live = outlets.values().filter_map(|o| o.channel.as_ref().map(|c| (c, &o.streams))).peekable();
        while let Some((channel, streams)) = live.next() {
            let mine = match frames_for(&batch, streams) {
                None if live.peek().is_none() => {
                    let _ = channel.send(InvokeResponseBody::Raw(batch));
                    return;
                }
                None => batch.clone(),
                Some(f) => f,
            };
            if !mine.is_empty() {
                let _ = channel.send(InvokeResponseBody::Raw(mine));
            }
        }
    }

    /// A window reports what it shows. Returns the focus for the core, and every window's
    /// targets when this one's changed.
    pub fn set_focus(&self, label: &str, focus: FocusState, targets: Option<Vec<String>>) -> (FocusState, Option<Vec<WindowView>>) {
        let mut views = self.views.lock().unwrap();
        let view = views.entry(label.to_string()).or_default();
        if focus.window_focused {
            *self.last_focused.lock().unwrap() = Some(label.to_string());
        }
        view.focus = focus;
        let changed = targets.is_some_and(|t| {
            let changed = t != view.targets;
            view.targets = t;
            changed
        });
        let merged = merge(&views, self.last_focused.lock().unwrap().as_deref());
        (merged, changed.then(|| window_views(&views)))
    }

    /// The window to bring up for `key`: one showing it (the last focused first), else the last
    /// focused, else main.
    pub fn window_for(&self, key: Option<u32>) -> String {
        let views = self.views.lock().unwrap();
        let last = self.last_focused.lock().unwrap().clone();
        let showing = |l: &String| key.is_some_and(|k| views.get(l).is_some_and(|v| v.focus.on_screen(k)));
        last.iter()
            .chain(views.keys())
            .find(|l| showing(l))
            .cloned()
            .or(last)
            .unwrap_or_else(|| MAIN.to_string())
    }

    pub fn views(&self) -> Vec<WindowView> {
        window_views(&self.views.lock().unwrap())
    }

    /// The focus once a window is gone.
    pub fn merged(&self) -> FocusState {
        merge(&self.views.lock().unwrap(), self.last_focused.lock().unwrap().as_deref())
    }
}

fn window_views(views: &BTreeMap<String, View>) -> Vec<WindowView> {
    views.iter().map(|(label, v)| WindowView { label: label.clone(), targets: v.targets.clone() }).collect()
}

/// The frames of `batch` for a window streaming `streams`: every tile, and raw output and resets
/// only for its own panes. None when that's all of them.
pub fn frames_for(batch: &[u8], streams: &HashSet<u32>) -> Option<Vec<u8>> {
    let mut keep = Vec::new();
    let mut all = true;
    let mut i = 0;
    while i + 9 <= batch.len() {
        let key = u32::from_le_bytes(batch[i + 1..i + 5].try_into().unwrap());
        let len = u32::from_le_bytes(batch[i + 5..i + 9].try_into().unwrap()) as usize;
        let end = (i + 9 + len).min(batch.len());
        if batch[i] == frames::TILE || streams.contains(&key) {
            keep.push(i..end);
        } else {
            all = false;
        }
        i = end;
    }
    if all {
        return None;
    }
    Some(keep.into_iter().flat_map(|r| batch[r].iter().copied()).collect())
}

/// One focus from every window's: focused if any is, worked in where the focused (else the last
/// focused) window works, and everything else any window shows.
fn merge(views: &BTreeMap<String, View>, last: Option<&str>) -> FocusState {
    let focused = views.iter().find(|(_, v)| v.focus.window_focused).map(|(l, _)| l.as_str());
    let expanded = focused.or(last).and_then(|l| views.get(l)).and_then(|v| v.focus.expanded);
    let mut visible: Vec<u32> = views.values().flat_map(|v| v.focus.shown()).filter(|k| Some(*k) != expanded).collect();
    visible.sort_unstable();
    visible.dedup();
    FocusState { expanded, window_focused: focused.is_some(), visible }
}

/// The first free "win-N" (N ≥ 2: main is the first window).
pub fn next_label(taken: &[String]) -> String {
    (2..).map(|n| format!("win-{n}")).find(|l| !taken.contains(l)).unwrap()
}

#[cfg(desktop)]
fn saved(state: &AppState) -> Vec<String> {
    state.core.ui_state().get(SAVED).and_then(|v| serde_json::from_str(v).ok()).unwrap_or_default()
}

#[cfg(desktop)]
fn save(state: &AppState, labels: &[String]) {
    state.core.set_ui_state(SAVED.into(), (!labels.is_empty()).then(|| serde_json::to_string(labels).unwrap()));
}

#[cfg(desktop)]
fn build(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let base = app.config().app.windows.first().cloned().unwrap_or_default();
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title(base.title)
        .inner_size(base.width * 0.8, base.height * 0.8)
        .min_inner_size(base.min_width.unwrap_or(760.0), base.min_height.unwrap_or(480.0))
        .background_color(base.background_color.unwrap_or(tauri::window::Color(11, 13, 18, 255)))
        .build()?;
    Ok(())
}

#[cfg(desktop)]
/// Opens the windows that were open when the app last quit.
pub fn restore(app: &AppHandle) {
    let state = app.state::<AppState>();
    for label in saved(&state) {
        if label.starts_with("win-")
            && app.get_webview_window(&label).is_none()
            && let Err(e) = build(app, &label)
        {
            tracing::warn!("couldn't open window {label}: {e}");
        }
    }
}

#[cfg(desktop)]
/// A new window, with a grid of its own.
pub fn open(app: &AppHandle) -> tauri::Result<String> {
    let state = app.state::<AppState>();
    let taken: Vec<String> = app.webview_windows().into_keys().collect();
    let label = next_label(&taken);
    build(app, &label)?;
    let mut labels = saved(&state);
    labels.push(label.clone());
    save(&state, &labels);
    Ok(label)
}

#[cfg(desktop)]
/// An extra window was closed for good: it won't come back, nor its layout.
pub fn closed(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let labels: Vec<String> = saved(&state).into_iter().filter(|l| l != label).collect();
    save(&state, &labels);
    state.core.set_ui_state(format!("consuls.layout.{label}.v1"), None);
}

/// A window went away (closed, or the app is ending): its streams and focus go with it.
pub fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    for key in state.sink.windows.remove(label) {
        state.core.stream_pane(key, false);
    }
    state.core.set_focus(state.sink.windows.merged());
    let _ = app.emit("window-views", state.sink.windows.views());
}

#[cfg(desktop)]
/// Brings up the window that should show `key` (a toast was clicked) and tells it.
pub fn show_pane(app: &AppHandle, key: Option<u32>) {
    let label = app.state::<AppState>().sink.windows.window_for(key);
    show(app, &label);
    if let Some(key) = key {
        let _ = app.emit_to(&label, "focus-pane", key);
    }
}

#[cfg(desktop)]
pub fn show(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label).or_else(|| app.get_webview_window(MAIN)) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(expanded: Option<u32>, focused: bool, visible: &[u32]) -> View {
        View { focus: FocusState { expanded, window_focused: focused, visible: visible.to_vec() }, targets: vec![] }
    }

    #[test]
    fn merges_windows() {
        let mut v = BTreeMap::new();
        v.insert("main".to_string(), view(Some(1), false, &[2]));
        v.insert("win-2".to_string(), view(Some(3), true, &[2, 4]));
        assert_eq!(merge(&v, Some("main")), FocusState { expanded: Some(3), window_focused: true, visible: vec![1, 2, 4] });
        // None focused: the last focused window's pane is still the one worked in.
        v.get_mut("win-2").unwrap().focus.window_focused = false;
        assert_eq!(merge(&v, Some("main")), FocusState { expanded: Some(1), window_focused: false, visible: vec![2, 3, 4] });
        assert_eq!(merge(&BTreeMap::new(), None), FocusState::default());
    }

    #[test]
    fn picks_labels() {
        assert_eq!(next_label(&["main".into()]), "win-2");
        assert_eq!(next_label(&["main".into(), "win-2".into(), "win-4".into()]), "win-3");
    }

    #[test]
    fn frames_go_where_streamed() {
        let tile = frames::encode(frames::TILE, 7, b"t");
        let raw = frames::encode(frames::RAW, 7, b"raw");
        let other = frames::encode(frames::RESET, 9, b"reset");
        let batch = [tile.clone(), raw.clone(), other.clone()].concat();
        assert_eq!(frames_for(&batch, &HashSet::from([7, 9])), None);
        assert_eq!(frames_for(&batch, &HashSet::from([7])), Some([tile.clone(), raw].concat()));
        assert_eq!(frames_for(&batch, &HashSet::new()), Some(tile));
    }

    #[test]
    fn streams_are_counted_per_window() {
        let w = Windows::default();
        assert!(w.stream("main", 5, true));
        assert!(w.stream("win-2", 5, true), "a second view needs its own reset");
        assert!(!w.stream("main", 5, false), "win-2 still streams it");
        assert_eq!(w.remove("win-2"), vec![5]);
        assert!(w.stream("main", 6, true));
        assert!(w.stream("main", 6, false));
    }

    #[test]
    fn finds_the_window_for_a_pane() {
        let w = Windows::default();
        w.set_focus("main", FocusState { expanded: Some(1), window_focused: false, visible: vec![] }, None);
        w.set_focus("win-2", FocusState { expanded: Some(2), window_focused: true, visible: vec![] }, None);
        assert_eq!(w.window_for(Some(1)), "main");
        assert_eq!(w.window_for(Some(9)), "win-2", "not shown: the last focused window");
        let (_, views) = w.set_focus("main", FocusState::default(), Some(vec!["pane:a".into()]));
        assert_eq!(views.unwrap()[0], WindowView { label: "main".into(), targets: vec!["pane:a".into()] });
        assert!(w.set_focus("main", FocusState::default(), Some(vec!["pane:a".into()])).1.is_none(), "unchanged");
    }
}
