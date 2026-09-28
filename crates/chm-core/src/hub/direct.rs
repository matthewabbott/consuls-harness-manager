//! Direct panes: a shell on a PTY we own (an SSH channel or a local pseudo-console), with no
//! tmux in between. The session is lost when its connection (or the app) goes away; the pane
//! then shows why it ended but stays readable until dismissed. It is never revived.
//!
//! Each pane is one task that owns the PTY and a full-history terminal. Unlike tmux panes the
//! core answers terminal queries itself (cursor position, device attributes, colours), so
//! programs behave the same whether or not the pane is open in the UI.

use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::event::{Event, WindowSize};
use alacritty_terminal::term::TermMode;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::attention::{PaneLabel, Signal};
use super::ctx::Ctx;
use super::frames;
use super::tmux_mgr::PaneCmd;
use crate::harness::Harness;
use crate::integration::events::HookEvent;
use crate::model::{HostId, PaneInfo, PaneKind, ResizeOutcome, TerminateOutcome};
use crate::pty::{Pty, PtyInput, PtyOutput};
use crate::term::{Collector, TileTerm, palette_rgb};

/// Scrollback kept for a direct pane (it's the only copy).
const HISTORY: usize = 10_000;

pub(crate) enum DirectMsg {
    Pane(PaneCmd),
    /// A harness hook event for this pane (routed by `CHM_PANE=direct:<chm_id>`).
    Hook { event: HookEvent, stale: bool },
    /// The UI reloaded: re-send the tile, stop streaming.
    Resend,
    /// Hang up and remove the pane (its host was removed).
    Close,
}

pub(crate) struct DirectHandle {
    pub info: PaneInfo,
    pub tx: mpsc::UnboundedSender<DirectMsg>,
}

pub(crate) struct DirectSpec {
    pub host: HostId,
    pub cwd: String,
    /// What's running, for the tile (e.g. `bash`, `pwsh`).
    pub command: String,
    pub harness: Option<Harness>,
    pub chm_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Registers a new direct pane around a running PTY session and returns its key.
pub(crate) fn spawn(ctx: &Arc<Ctx>, rt: &tokio::runtime::Handle, spec: DirectSpec, pty: Pty) -> u32 {
    let key = ctx.alloc_key();
    let info = PaneInfo {
        key,
        host: spec.host,
        kind: PaneKind::Direct,
        tmux: None,
        width: spec.cols,
        height: spec.rows,
        current_command: spec.command,
        current_path: spec.cwd,
        title: String::new(),
        harness: spec.harness.or(Some(Harness::Shell)),
        alternate_on: false,
        chm_id: Some(spec.chm_id),
        hidden: false,
        labels: Vec::new(),
        ended: None,
    };
    let (tx, rx) = mpsc::unbounded_channel();
    ctx.direct.lock().unwrap().insert(key, DirectHandle { info: info.clone(), tx });
    ctx.set_direct(info.clone());
    let events = Collector::default();
    let pane = Direct {
        ctx: ctx.clone(),
        key,
        term: TileTerm::with_listener(spec.cols, spec.rows, HISTORY, events.clone()),
        events,
        info,
        input: pty.input,
        streaming: false,
        dirty: true,
        publish_due: false,
        last_output: None,
        burst_start: None,
        heuristic_working: false,
        last_hook: None,
    };
    rt.spawn(run(pane, pty.output, rx));
    key
}

/// Routes a hook event carrying `pane: "direct:<chm_id>"` to its pane. Returns whether a
/// direct pane took it.
pub(crate) fn route_hook(ctx: &Ctx, event: &HookEvent, stale: bool) -> bool {
    let Some(id) = event.pane.strip_prefix("direct:") else { return false };
    let direct = ctx.direct.lock().unwrap();
    match direct.values().find(|d| d.info.chm_id.as_deref() == Some(id)) {
        Some(d) => d.tx.send(DirectMsg::Hook { event: event.clone(), stale }).is_ok(),
        None => false,
    }
}

struct Direct {
    ctx: Arc<Ctx>,
    key: u32,
    info: PaneInfo,
    term: TileTerm<Collector>,
    events: Collector,
    input: mpsc::UnboundedSender<PtyInput>,
    streaming: bool,
    dirty: bool,
    publish_due: bool,
    last_output: Option<Instant>,
    burst_start: Option<Instant>,
    heuristic_working: bool,
    last_hook: Option<(String, u64)>,
}

async fn run(mut d: Direct, mut output: mpsc::UnboundedReceiver<PtyOutput>, mut rx: mpsc::UnboundedReceiver<DirectMsg>) {
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut output_open = true;
    loop {
        tokio::select! {
            out = output.recv(), if output_open => match out {
                Some(PtyOutput::Data(bytes)) => d.on_output(&bytes),
                Some(PtyOutput::Exited(reason)) => d.on_exit(reason),
                None => {
                    output_open = false;
                    d.on_exit("Connection lost".into());
                }
            },
            msg = rx.recv() => match msg {
                None | Some(DirectMsg::Close) => {
                    d.close();
                    return;
                }
                Some(DirectMsg::Resend) => {
                    d.streaming = false;
                    d.dirty = true;
                }
                Some(DirectMsg::Hook { event, stale }) => d.on_hook(&event, stale),
                Some(DirectMsg::Pane(cmd)) => {
                    if !d.pane_cmd(cmd) {
                        return;
                    }
                }
            },
            _ = tick.tick() => d.tick(),
        }
    }
}

impl Direct {
    fn write(&self, bytes: Vec<u8>) {
        if self.info.ended.is_none() && !bytes.is_empty() {
            let _ = self.input.send(PtyInput::Data(bytes));
        }
    }

    fn publish(&mut self) {
        self.publish_due = false;
        self.ctx.set_direct(self.info.clone());
    }

    fn on_output(&mut self, bytes: &[u8]) {
        self.term.feed(bytes);
        self.dirty = true;
        let now = Instant::now();
        match self.last_output {
            Some(t) if now.duration_since(t) < Duration::from_millis(1500) => {}
            _ => self.burst_start = Some(now),
        }
        self.last_output = Some(now);
        if self.streaming {
            self.ctx.sink.frame(frames::encode(frames::RAW, self.key, bytes));
        }
        let alt = self.term.mode().contains(TermMode::ALT_SCREEN);
        if alt != self.info.alternate_on {
            self.info.alternate_on = alt;
            self.publish_due = true;
        }
        for event in self.events.drain() {
            match event {
                Event::PtyWrite(s) => self.write(s.into_bytes()),
                Event::ColorRequest(index, format) => self.write(format(palette_rgb(index)).into_bytes()),
                Event::TextAreaSizeRequest(format) => {
                    let (cols, rows) = self.term.size();
                    self.write(format(WindowSize { num_lines: rows, num_cols: cols, cell_width: 9, cell_height: 18 }).into_bytes());
                }
                Event::Title(title) => {
                    if self.info.title != title {
                        self.info.title = title;
                        self.publish_due = true;
                    }
                }
                Event::ResetTitle if !self.info.title.is_empty() => {
                    self.info.title.clear();
                    self.publish_due = true;
                }
                // Bells and OSC 52 clipboard writes are handled in later milestones; clipboard
                // reads are never answered (a remote program shouldn't read the clipboard).
                _ => {}
            }
        }
    }

    fn on_exit(&mut self, reason: String) {
        if self.info.ended.is_none() {
            self.info.ended = Some(reason);
            self.publish();
        }
    }

    fn reset_frame(&self) {
        let (cols, rows) = self.term.size();
        let mut payload = Vec::new();
        payload.extend_from_slice(&cols.to_le_bytes());
        payload.extend_from_slice(&rows.to_le_bytes());
        payload.extend_from_slice(&self.term.serialize());
        self.ctx.sink.frame(frames::encode(frames::RESET, self.key, &payload));
    }

    fn close(&mut self) {
        let _ = self.input.send(PtyInput::Close);
        self.ctx.streaming.lock().unwrap().remove(&self.key);
        self.ctx.remove_direct(self.key);
    }

    /// Returns false when the pane is gone.
    fn pane_cmd(&mut self, cmd: PaneCmd) -> bool {
        let app_cursor = self.term.mode().contains(TermMode::APP_CURSOR);
        let bracketed = self.term.mode().contains(TermMode::BRACKETED_PASTE);
        match cmd {
            PaneCmd::Stream { on, .. } => {
                self.streaming = on;
                if on {
                    self.reset_frame();
                }
            }
            PaneCmd::Keys { keys, .. } => self.write(keys_to_bytes(&keys, app_cursor)),
            PaneCmd::Text { text, .. } => self.write(text.into_bytes()),
            PaneCmd::Input { data, .. } => self.write(data),
            PaneCmd::Paste { text, .. } => self.write(paste_bytes(&text, bracketed)),
            PaneCmd::Submit { text, .. } => {
                let text = text.trim_end_matches(['\n', '\r']).to_string();
                if text.is_empty() || self.info.ended.is_some() {
                    return true;
                }
                let settle = match self.info.harness {
                    Some(Harness::Codex) => 350,
                    _ if text.len() > 800 || text.contains('\n') => 300,
                    _ => 180,
                };
                let input = self.input.clone();
                let bytes = paste_bytes(&text, bracketed);
                tokio::spawn(async move {
                    let _ = input.send(PtyInput::Data(bytes));
                    tokio::time::sleep(Duration::from_millis(settle)).await;
                    let _ = input.send(PtyInput::Data(b"\r".to_vec()));
                });
            }
            PaneCmd::Resize { cols, rows, reply, .. } => {
                let (cols, rows) = (cols.clamp(20, 1000), rows.clamp(5, 500));
                if (cols, rows) != self.term.size() {
                    self.term.resize(cols, rows);
                    let _ = self.input.send(PtyInput::Resize { cols, rows });
                    self.info.width = cols;
                    self.info.height = rows;
                    self.publish();
                    self.dirty = true;
                }
                if self.streaming {
                    self.reset_frame();
                }
                let _ = reply.send(Ok(ResizeOutcome { other_clients: 0 }));
            }
            PaneCmd::ReleaseSize { .. } => {}
            PaneCmd::SetLabels { labels, .. } => {
                let mut seen = std::collections::HashSet::new();
                self.info.labels = labels.into_iter().filter(|l| !l.trim().is_empty() && seen.insert(l.clone())).collect();
                self.publish();
            }
            PaneCmd::Hide { hidden, .. } => {
                self.info.hidden = hidden;
                self.publish();
            }
            PaneCmd::Terminate { reply, .. } => {
                self.close();
                let _ = reply.send(Ok(TerminateOutcome::Closed));
                return false;
            }
        }
        true
    }

    fn label(&self) -> PaneLabel {
        let cleaned = self.info.title.trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
        let title = if cleaned.is_empty() || cleaned.contains('@') { self.info.current_command.clone() } else { cleaned.chars().take(60).collect() };
        let host = if self.info.host == crate::local::LOCAL_HOST { "this PC".to_string() } else { self.info.host.clone() };
        PaneLabel { title, harness: display_name(self.info.harness).into(), host }
    }

    fn on_hook(&mut self, event: &HookEvent, stale: bool) {
        if let Some((e, ts)) = &self.last_hook
            && *e == event.event
            && event.ts.abs_diff(*ts) <= 1
        {
            return;
        }
        self.last_hook = Some((event.event.clone(), event.ts));
        if let Some(h) = Harness::from_name(&event.harness)
            && self.info.harness != Some(h)
        {
            self.info.harness = Some(h);
            self.publish();
        }
        let sig = Signal { event: event.event.clone(), detail: event.detail.clone(), ts: event.ts, heuristic: false };
        self.ctx.signal(self.key, &sig, &self.label(), stale);
    }

    fn tick(&mut self) {
        if self.publish_due {
            self.publish();
        }
        self.heuristics(Instant::now());
        if self.dirty && self.ctx.is_visible(self.key) {
            self.dirty = false;
            self.ctx.sink.frame(frames::encode(frames::TILE, self.key, &self.term.snapshot()));
        }
    }

    /// Agents without hooks: sustained output = working; a long silence after it = finished.
    fn heuristics(&mut self, now: Instant) {
        let agent = matches!(self.info.harness, Some(h) if h != Harness::Shell);
        if !agent || self.info.ended.is_some() || self.ctx.attention.lock().unwrap().has_hooks(self.key) {
            return;
        }
        let (Some(last), Some(burst)) = (self.last_output, self.burst_start) else { return };
        let event = if !self.heuristic_working && now.duration_since(last) < Duration::from_millis(1500) && now.duration_since(burst) > Duration::from_secs(4) {
            self.heuristic_working = true;
            "HeuristicWorking"
        } else if self.heuristic_working && now.duration_since(last) > Duration::from_secs(7) {
            self.heuristic_working = false;
            "HeuristicIdle"
        } else {
            return;
        };
        let sig = Signal { event: event.into(), detail: String::new(), ts: 0, heuristic: true };
        self.ctx.signal(self.key, &sig, &self.label(), false);
    }
}

fn display_name(h: Option<Harness>) -> &'static str {
    match h {
        Some(Harness::Claude) => "Claude Code",
        Some(Harness::Codex) => "Codex",
        Some(Harness::Omp) => "omp",
        Some(Harness::Pi) => "pi",
        Some(Harness::Opencode) => "opencode",
        Some(Harness::Gemini) => "Gemini",
        Some(Harness::Shell) | None => "the shell",
    }
}

/// Bracketed (when the program asked for it) paste bytes. Embedded end markers are removed so
/// pasted text can't break out of the paste, and newlines become CR like a typed Enter.
pub(crate) fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    let body = text.replace("\x1b[201~", "").replace("\r\n", "\r").replace('\n', "\r");
    if bracketed { format!("\x1b[200~{body}\x1b[201~").into_bytes() } else { body.into_bytes() }
}

/// Encodes tmux key names (`Enter`, `C-c`, `M-f`, `S-Up`, `F5`, …) the way xterm would, for
/// panes without tmux to do it for us.
pub(crate) fn keys_to_bytes(keys: &[String], app_cursor: bool) -> Vec<u8> {
    let mut out = Vec::new();
    for key in keys {
        let (mut ctrl, mut alt, mut shift) = (false, false, false);
        let mut name = key.as_str();
        loop {
            if let Some(rest) = name.strip_prefix("C-").filter(|r| !r.is_empty()) {
                ctrl = true;
                name = rest;
            } else if let Some(rest) = name.strip_prefix("M-").filter(|r| !r.is_empty()) {
                alt = true;
                name = rest;
            } else if let Some(rest) = name.strip_prefix("S-").filter(|r| !r.is_empty()) {
                shift = true;
                name = rest;
            } else {
                break;
            }
        }
        let m = 1 + shift as u8 + 2 * alt as u8 + 4 * ctrl as u8;
        let csi = |out: &mut Vec<u8>, letter: char| {
            if m > 1 {
                out.extend_from_slice(format!("\x1b[1;{m}{letter}").as_bytes());
            } else if app_cursor {
                out.extend_from_slice(format!("\x1bO{letter}").as_bytes());
            } else {
                out.extend_from_slice(format!("\x1b[{letter}").as_bytes());
            }
        };
        let tilde = |out: &mut Vec<u8>, n: u8| {
            if m > 1 {
                out.extend_from_slice(format!("\x1b[{n};{m}~").as_bytes());
            } else {
                out.extend_from_slice(format!("\x1b[{n}~").as_bytes());
            }
        };
        let meta = |out: &mut Vec<u8>| {
            if alt {
                out.push(0x1b);
            }
        };
        match name {
            "Up" => csi(&mut out, 'A'),
            "Down" => csi(&mut out, 'B'),
            "Right" => csi(&mut out, 'C'),
            "Left" => csi(&mut out, 'D'),
            "Home" => csi(&mut out, 'H'),
            "End" => csi(&mut out, 'F'),
            "IC" => tilde(&mut out, 2),
            "DC" => tilde(&mut out, 3),
            "PPage" | "PageUp" => tilde(&mut out, 5),
            "NPage" | "PageDown" => tilde(&mut out, 6),
            "F1" | "F2" | "F3" | "F4" => {
                let letter = (b'P' + name.as_bytes()[1] - b'1') as char;
                if m > 1 {
                    out.extend_from_slice(format!("\x1b[1;{m}{letter}").as_bytes());
                } else {
                    out.extend_from_slice(format!("\x1bO{letter}").as_bytes());
                }
            }
            "F5" => tilde(&mut out, 15),
            "F6" => tilde(&mut out, 17),
            "F7" => tilde(&mut out, 18),
            "F8" => tilde(&mut out, 19),
            "F9" => tilde(&mut out, 20),
            "F10" => tilde(&mut out, 21),
            "F11" => tilde(&mut out, 23),
            "F12" => tilde(&mut out, 24),
            "Enter" => {
                meta(&mut out);
                out.push(b'\r');
            }
            "Tab" => {
                meta(&mut out);
                out.push(b'\t');
            }
            "BTab" => out.extend_from_slice(b"\x1b[Z"),
            "BSpace" => {
                meta(&mut out);
                out.push(if ctrl { 0x08 } else { 0x7f });
            }
            "Escape" => {
                meta(&mut out);
                out.push(0x1b);
            }
            "Space" => {
                meta(&mut out);
                out.push(if ctrl { 0 } else { b' ' });
            }
            _ => {
                let mut chars = name.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) => {
                        meta(&mut out);
                        if ctrl {
                            let lower = c.to_ascii_lowercase();
                            let byte = match lower {
                                'a'..='z' => lower as u8 & 0x1f,
                                '@' | ' ' | '2' => 0,
                                '[' | '3' => 0x1b,
                                '\\' | '4' => 0x1c,
                                ']' | '5' => 0x1d,
                                '^' | '6' => 0x1e,
                                '_' | '/' | '7' => 0x1f,
                                '?' | '8' => 0x7f,
                                _ => c as u8,
                            };
                            out.push(byte);
                        } else {
                            let c = if shift { c.to_ascii_uppercase() } else { c };
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                        }
                    }
                    // Not a key name: send it as text.
                    _ => out.extend_from_slice(key.as_bytes()),
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(k: &[&str], app: bool) -> Vec<u8> {
        keys_to_bytes(&k.iter().map(|s| s.to_string()).collect::<Vec<_>>(), app)
    }

    #[test]
    fn key_names_encode_like_xterm() {
        assert_eq!(keys(&["Enter"], false), b"\r");
        assert_eq!(keys(&["C-c"], false), [3]);
        assert_eq!(keys(&["C-j"], false), b"\n");
        assert_eq!(keys(&["Escape"], false), [0x1b]);
        assert_eq!(keys(&["Up"], false), b"\x1b[A");
        assert_eq!(keys(&["Up"], true), b"\x1bOA");
        assert_eq!(keys(&["C-Left"], true), b"\x1b[1;5D");
        assert_eq!(keys(&["S-Tab"], false), b"\t"); // tmux sends BTab for this
        assert_eq!(keys(&["BTab"], false), b"\x1b[Z");
        assert_eq!(keys(&["M-f"], false), b"\x1bf");
        assert_eq!(keys(&["PPage", "F5", "F1"], false), b"\x1b[5~\x1b[15~\x1bOP");
        assert_eq!(keys(&["BSpace", "C-BSpace"], false), [0x7f, 0x08]);
        assert_eq!(keys(&["y"], false), b"y");
        assert_eq!(keys(&["C-"], false), b"C-", "a lone modifier prefix is text");
    }

    #[test]
    fn paste_is_bracketed_and_sanitized() {
        assert_eq!(paste_bytes("a\nb", false), b"a\rb");
        assert_eq!(paste_bytes("x\x1b[201~y\r\n", true), b"\x1b[200~xy\r\x1b[201~");
    }
}
