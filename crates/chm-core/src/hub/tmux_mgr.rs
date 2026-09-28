//! Per-host tmux state: which sessions we're attached to, every pane's terminal state,
//! seeding, and tile snapshots.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, info, warn};

use super::attention::{PaneLabel, Signal};
use super::ctx::Ctx;
use super::frames;
use crate::harness::Harness;
use crate::integration::assets::{self, Assets};
use crate::model::{HostId, NewPaneSpec, NoticeLevel, PaneInfo, PaneKind, ResizeOutcome, TerminateOutcome, TmuxLoc};
use crate::ssh::SshConnection;
use crate::ssh::exec;
use crate::term::{Collector, TileTerm};
use crate::tmux::formats::{PANE_FORMAT, PaneRow, SESSION_FORMAT, SessionRow, parse_pane_row, parse_session_row};
use crate::tmux::quote::quote;
use crate::tmux::seed::{parse_seed, seed_command};
use crate::tmux::{ClientEvent, ClientKey, ControlClient, Event, PaneId, TmuxServer};

const IDLE_POLL_MIN: Duration = Duration::from_millis(1500);
const IDLE_POLL_MAX: Duration = Duration::from_secs(30);

/// Scrollback lines captured when a pane is opened in the expanded view.
const STREAM_HISTORY: u32 = 5000;

/// Commands aimed at one pane (by app-wide pane key).
#[derive(Debug)]
pub(crate) enum PaneCmd {
    /// Start/stop sending raw output (plus a full-history RESET) for the expanded view.
    Stream { key: u32, on: bool },
    /// tmux key names, e.g. `Enter`, `C-c`, `Up`, `M-f`.
    Keys { key: u32, keys: Vec<String> },
    /// Literal text typed by the user.
    Text { key: u32, text: String },
    /// Raw terminal input (xterm's own encoding; direct panes).
    Input { key: u32, data: Vec<u8> },
    /// Paste text (bracketed if the app asked for it).
    Paste { key: u32, text: String },
    /// Composer prompt: paste it, give the TUI a moment, then press Enter.
    Submit { key: u32, text: String },
    /// Resize the pane's tmux window so the pane is `cols`×`rows` (pins window-size).
    Resize { key: u32, cols: u16, rows: u16, reply: tokio::sync::oneshot::Sender<Result<ResizeOutcome, String>> },
    /// Undo our pin: give the window back to tmux's automatic sizing.
    ReleaseSize { key: u32 },
    /// Set the pane's labels (stored in tmux as `@chm_labels`, so every device agrees).
    SetLabels { key: u32, labels: Vec<String> },
    /// Ping (or not) on the terminal bell; `None` = the default for what's running.
    SetBell { key: u32, bell: Option<bool> },
    /// Hide/unhide (stored in tmux as `@chm_hidden`, so every device agrees).
    Hide { key: u32, hidden: bool },
    /// Quit the harness gracefully, then close the pane (or kill it outright with `force`).
    Terminate { key: u32, force: bool, reply: tokio::sync::oneshot::Sender<Result<TerminateOutcome, String>> },
}

const SEP_STR: &str = crate::tmux::formats::SEP;

/// Subscription reporting per-pane fields that change without any other notification.
const SUB_NAME: &str = "chm";
const SUB_FORMAT: &str = "#{pane_current_command}|~|#{alternate_on}|~|#{@chm_hidden}|~|#{@chm_labels}|~|#{@chm_bell}|~|#{pane_title}";

struct Client {
    client: Arc<ControlClient>,
    group_key: String,
}

struct Pane {
    key: u32,
    row: PaneRow,
    client: ClientKey,
    term: TileTerm<Collector>,
    /// The terminal's events (only bells matter here: tmux answers queries itself).
    events: Collector,
    /// Tag of an in-flight seed; output is dropped until it lands (it's in the capture).
    seeding: Option<u64>,
    dirty: bool,
    /// Expanded in the UI: raw output is forwarded as frames.
    streaming: bool,
    /// For the output-activity heuristic (panes without hooks).
    last_output: Option<Instant>,
    burst_start: Option<Instant>,
    heuristic_working: bool,
}

pub(crate) struct TmuxManager {
    host: HostId,
    conn: Arc<SshConnection>,
    ctx: Arc<Ctx>,
    server: TmuxServer,
    clients: HashMap<ClientKey, Client>,
    next_client: ClientKey,
    events_tx: mpsc::UnboundedSender<(ClientKey, ClientEvent)>,
    panes: BTreeMap<PaneId, Pane>,
    server_start: u64,
    next_tag: u64,
    seeds: HashMap<u64, (PaneId, bool)>,
    /// Replies to skip at the front of a tagged seed (commands prefixed to it, e.g. a resize).
    seed_skip: HashMap<u64, usize>,
    relist_due: Option<Instant>,
    discover_due: Option<Instant>,
    publish_due: bool,
    last_discover: Instant,
    /// How often to look for sessions while there are none (each look is an SSH exec, which on
    /// some hosts is a whole login session): 3 s, doubling to 30 s.
    idle_poll: Duration,
    home: Option<String>,
    assets: Option<Assets>,
    /// Last hook event per pane, to drop duplicates (per-launch + global hooks both firing).
    last_hook: HashMap<PaneId, (String, u64)>,
}

impl TmuxManager {
    pub fn new(
        host: HostId,
        conn: Arc<SshConnection>,
        ctx: Arc<Ctx>,
        server: TmuxServer,
    ) -> (Self, mpsc::UnboundedReceiver<(ClientKey, ClientEvent)>) {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let mgr = Self {
            host,
            conn,
            ctx,
            server,
            clients: HashMap::new(),
            next_client: 1,
            events_tx,
            panes: BTreeMap::new(),
            server_start: 0,
            next_tag: 1,
            seeds: HashMap::new(),
            seed_skip: HashMap::new(),
            relist_due: None,
            discover_due: None,
            publish_due: false,
            last_discover: Instant::now(),
            idle_poll: IDLE_POLL_MIN,
            home: None,
            assets: None,
            last_hook: HashMap::new(),
        };
        (mgr, events_rx)
    }

    fn any_client(&self) -> Option<Arc<ControlClient>> {
        self.clients.values().find(|c| !c.client.is_closed()).map(|c| c.client.clone())
    }

    async fn list_sessions(&self) -> Result<Vec<SessionRow>, String> {
        let text = if let Some(client) = self.any_client() {
            client
                .command(&format!("list-sessions -F {}", quote(SESSION_FORMAT)))
                .await
                .map_err(|e| e.to_string())?
                .text()
        } else {
            let script = format!("{} list-sessions -F {} 2>&1", self.server.prefix(), exec::sh_quote(SESSION_FORMAT));
            let out = exec::run(&self.conn, &script, Duration::from_secs(20)).await.map_err(|e| e.to_string())?;
            let text = out.stdout_str();
            debug!(host = %self.host, "list-sessions via exec: status={:?} out={text:?}", out.status);
            if !out.success() {
                // "no server running" / "error connecting to …" just mean no sessions yet.
                if text.contains("no server running") || text.contains("error connecting") || text.contains("No such file") {
                    return Ok(Vec::new());
                }
                return Err(text.trim().to_string());
            }
            text
        };
        Ok(text.lines().filter_map(parse_session_row).collect())
    }

    /// Attaches to every session group we aren't attached to yet, and drops clients whose
    /// sessions are gone.
    pub async fn discover(&mut self) {
        self.last_discover = Instant::now();
        self.idle_poll = if self.clients.is_empty() { (self.idle_poll * 2).min(IDLE_POLL_MAX) } else { IDLE_POLL_MIN };
        self.discover_due = None;
        let sessions = match self.list_sessions().await {
            Ok(s) => s,
            Err(e) => {
                warn!(host = %self.host, "list-sessions failed: {e}");
                return;
            }
        };
        if let Some(first) = sessions.first()
            && first.server_start != self.server_start
        {
            if self.server_start != 0 {
                info!(host = %self.host, "tmux server restarted");
            }
            self.server_start = first.server_start;
        }

        debug!(host = %self.host, "discovered {} tmux sessions", sessions.len());
        let mut groups: BTreeMap<String, &SessionRow> = BTreeMap::new();
        for s in &sessions {
            groups.entry(s.group_key()).or_insert(s);
        }

        self.clients.retain(|_, c| !c.client.is_closed() && groups.contains_key(&c.group_key));
        let attached: Vec<String> = self.clients.values().map(|c| c.group_key.clone()).collect();

        for (group_key, session) in groups {
            if attached.contains(&group_key) {
                continue;
            }
            let key = self.next_client;
            self.next_client += 1;
            let target = format!("${}", session.session);
            match ControlClient::attach(&self.conn, &self.server, &target, key, self.events_tx.clone()).await {
                Ok(client) => {
                    debug!(host = %self.host, "attached control client {key} to {} ({group_key})", session.name);
                    let sub = format!("refresh-client -B {}", quote(&format!("{SUB_NAME}:%*:{SUB_FORMAT}")));
                    if let Err(e) = client.command(&sub).await {
                        warn!(host = %self.host, "subscription failed: {e}");
                    }
                    self.clients.insert(key, Client { client: Arc::new(client), group_key });
                }
                Err(e) => warn!(host = %self.host, "attach to {} failed: {e}", session.name),
            }
        }
        self.relist().await;
    }

    /// Re-reads every pane from tmux and reconciles our registry.
    pub async fn relist(&mut self) {
        self.relist_due = None;
        let mut rows: BTreeMap<PaneId, (ClientKey, PaneRow)> = BTreeMap::new();
        let keys: Vec<ClientKey> = self.clients.keys().copied().collect();
        for key in keys {
            let client = self.clients[&key].client.clone();
            match client.command(&format!("list-panes -s -F {}", quote(PANE_FORMAT))).await {
                Ok(reply) => {
                    for row in reply.lines.iter().filter_map(|l| parse_pane_row(&String::from_utf8_lossy(l))) {
                        rows.entry(row.pane).or_insert((key, row));
                    }
                }
                Err(e) => debug!(host = %self.host, "list-panes on client {key} failed: {e}"),
            }
        }

        self.panes.retain(|id, _| rows.contains_key(id));
        let mut to_seed = Vec::new();
        for (id, (client, row)) in rows {
            match self.panes.get_mut(&id) {
                Some(p) => {
                    let resized = (p.row.width, p.row.height) != (row.width, row.height);
                    p.client = client;
                    p.row = row;
                    if resized {
                        p.term.resize(p.row.width, p.row.height);
                        to_seed.push(id);
                    }
                }
                None => {
                    let key = self.ctx.pane_key(&self.host, self.server_start, id);
                    let events = Collector::default();
                    let term = TileTerm::with_listener(row.width, row.height, 0, events.clone());
                    let streaming = self.ctx.streaming.lock().unwrap().contains(&key);
                    let pane = Pane {
                        key,
                        row,
                        client,
                        term,
                        events,
                        seeding: None,
                        dirty: true,
                        streaming,
                        last_output: None,
                        burst_start: None,
                        heuristic_working: false,
                    };
                    self.panes.insert(id, pane);
                    to_seed.push(id);
                }
            }
        }
        for id in to_seed {
            self.seed(id).await;
        }
        self.publish();
    }

    async fn seed(&mut self, id: PaneId) {
        self.seed_after(id, None).await;
    }

    /// Seeds the pane, optionally running `prefix` (a command line of `n` commands) first in
    /// the same line, so nothing happens between e.g. a resize and the capture.
    async fn seed_after(&mut self, id: PaneId, prefix: Option<(String, usize)>) {
        let tag = self.next_tag;
        self.next_tag += 1;
        let Some(pane) = self.panes.get_mut(&id) else { return };
        let Some(client) = self.clients.get(&pane.client).map(|c| c.client.clone()) else { return };
        let history = if pane.streaming { STREAM_HISTORY } else { 0 };
        let (mut cmd, mut replies) = seed_command(id, history);
        let skip = prefix.as_ref().map_or(0, |(_, n)| *n);
        if let Some((pre, n)) = prefix {
            cmd = format!("{pre} ; {cmd}");
            replies += n;
        }
        pane.seeding = Some(tag);
        self.seeds.insert(tag, (id, history > 0));
        self.seed_skip.insert(tag, skip);
        if let Err(e) = client.send_tagged(&cmd, replies, tag).await {
            debug!(host = %self.host, "seed %{id} failed: {e}");
            self.seeds.remove(&tag);
            if let Some(p) = self.panes.get_mut(&id) {
                p.seeding = None;
            }
        }
    }

    pub fn publish(&mut self) {
        self.publish_due = false;
        let infos: Vec<PaneInfo> = self.panes.values().map(|p| self.info(p)).collect();
        self.ctx.set_panes(&self.host, infos);
    }

    fn info(&self, p: &Pane) -> PaneInfo {
        let r = &p.row;
        PaneInfo {
            key: p.key,
            host: self.host.clone(),
            kind: PaneKind::Tmux,
            tmux: Some(TmuxLoc {
                pane_id: format!("%{}", r.pane),
                window_id: format!("@{}", r.window),
                session_id: format!("${}", r.session),
                session_name: r.session_name.clone(),
                session_group: r.session_group.clone(),
                window_index: r.window_index,
                window_name: r.window_name.clone(),
                pane_index: r.pane_index,
                dead: r.dead,
                window_active: r.window_active,
                pane_active: r.pane_active,
                window_panes: r.window_panes,
                sized: r.sized,
            }),
            width: r.width,
            height: r.height,
            current_command: r.current_command.clone(),
            current_path: r.current_path.clone(),
            title: r.title.clone(),
            harness: Harness::detect(&r.current_command, r.chm_harness.as_deref()),
            alternate_on: r.alternate_on,
            chm_id: r.chm_id.clone(),
            hidden: r.chm_hidden,
            labels: r.labels.clone(),
            ended: None,
            bell: r.bell,
            bell_pings: crate::harness::bell_pings(r.bell, &r.current_command),
        }
    }

    fn schedule_relist(&mut self) {
        let due = Instant::now() + Duration::from_millis(120);
        self.relist_due = Some(self.relist_due.map_or(due, |d| d.min(due)));
    }

    fn schedule_discover(&mut self) {
        let due = Instant::now() + Duration::from_millis(150);
        self.discover_due = Some(self.discover_due.map_or(due, |d| d.min(due)));
    }

    pub async fn on_event(&mut self, client: ClientKey, ev: ClientEvent) {
        match ev {
            ClientEvent::Tmux(Event::Output { pane, data }) => match self.panes.get_mut(&pane) {
                Some(p) if p.seeding.is_none() => {
                    p.term.feed(&data);
                    p.dirty = true;
                    let events = p.events.drain();
                    // OSC 52 (tmux passes the pane's raw output on).
                    for e in &events {
                        if let alacritty_terminal::event::Event::ClipboardStore(alacritty_terminal::term::ClipboardType::Clipboard, text) = e {
                            self.ctx.clipboard(p.key, text.clone());
                        }
                    }
                    let rang = events.iter().any(|e| matches!(e, alacritty_terminal::event::Event::Bell));
                    if rang && crate::harness::bell_pings(p.row.bell, &p.row.current_command) {
                        let sig = Signal { event: "Bell".into(), detail: String::new(), ts: 0, heuristic: false };
                        let (key, label) = (p.key, self.label(&self.panes[&pane]));
                        self.ctx.signal(key, &sig, &label, false);
                    }
                    let Some(p) = self.panes.get_mut(&pane) else { return };
                    let now = Instant::now();
                    match p.last_output {
                        Some(t) if now.duration_since(t) < Duration::from_millis(1500) => {}
                        _ => p.burst_start = Some(now),
                    }
                    p.last_output = Some(now);
                    if p.streaming {
                        self.ctx.sink.frame(frames::encode(frames::RAW, p.key, &data));
                    }
                }
                Some(_) => {}
                None => self.schedule_relist(),
            },
            ClientEvent::Tagged { tag, replies } => {
                let Some((id, with_history)) = self.seeds.remove(&tag) else { return };
                let skip = self.seed_skip.remove(&tag).unwrap_or(0);
                let replies = if replies.len() >= skip && replies[..skip].iter().all(|r| r.ok) {
                    replies[skip..].to_vec()
                } else {
                    let err = replies.iter().find(|r| !r.ok).map(|r| r.text()).unwrap_or_default();
                    self.ctx.notice(Some(&self.host), NoticeLevel::Warning, format!("Resize failed: {err}"));
                    Vec::new()
                };
                let Some(p) = self.panes.get_mut(&id) else { return };
                if p.seeding != Some(tag) {
                    return; // superseded by a newer seed
                }
                p.seeding = None;
                match parse_seed(&replies, with_history) {
                    Some(seed) => {
                        let (w, h) = (seed.modes.width, seed.modes.height);
                        p.term.resize(w, h);
                        p.term.feed(&seed.screen_only().to_terminal_bytes());
                        p.dirty = true;
                        if p.streaming {
                            let mut payload = Vec::new();
                            payload.extend_from_slice(&w.to_le_bytes());
                            payload.extend_from_slice(&h.to_le_bytes());
                            payload.extend_from_slice(&seed.to_terminal_bytes());
                            self.ctx.sink.frame(frames::encode(frames::RESET, p.key, &payload));
                        }
                    }
                    None => {
                        debug!(host = %self.host, "seed of %{id} failed: {:?}", replies.last().map(|r| r.text()));
                        self.schedule_relist();
                    }
                }
            }
            ClientEvent::Tmux(Event::Pause { pane }) => {
                debug!(host = %self.host, "pane %{pane} paused (client fell behind); re-seeding");
                self.seed(pane).await;
            }
            ClientEvent::Tmux(Event::SubscriptionChanged { name, pane: Some(pane), value }) if name == SUB_NAME => {
                let mut parts = value.splitn(6, crate::tmux::formats::SEP);
                let cmd = parts.next().unwrap_or_default().to_string();
                let alt = parts.next() == Some("1");
                let hidden = parts.next() == Some("1");
                let labels = crate::tmux::formats::parse_labels(parts.next().unwrap_or_default());
                let bell = crate::tmux::formats::parse_bell(parts.next().unwrap_or_default());
                let title = parts.next().unwrap_or_default().to_string();
                let mut reseed = false;
                if let Some(p) = self.panes.get_mut(&pane)
                    && (p.row.current_command != cmd
                        || p.row.title != title
                        || p.row.alternate_on != alt
                        || p.row.chm_hidden != hidden
                        || p.row.labels != labels
                        || p.row.bell != bell)
                {
                    reseed = p.row.alternate_on != alt;
                    p.row.current_command = cmd;
                    p.row.title = title;
                    p.row.alternate_on = alt;
                    p.row.chm_hidden = hidden;
                    p.row.labels = labels;
                    p.row.bell = bell;
                    self.publish_due = true;
                }
                if reseed {
                    // Our tile terminal only has the screen tmux showed us; re-capture.
                    self.seed(pane).await;
                }
            }
            ClientEvent::Tmux(
                Event::WindowAdd { .. }
                | Event::WindowClose { .. }
                | Event::WindowRenamed { .. }
                | Event::UnlinkedWindowAdd { .. }
                | Event::UnlinkedWindowClose { .. }
                | Event::UnlinkedWindowRenamed { .. }
                | Event::LayoutChange { .. }
                | Event::WindowPaneChanged { .. }
                | Event::SessionWindowChanged { .. }
                | Event::PaneModeChanged { .. },
            ) => self.schedule_relist(),
            ClientEvent::Tmux(Event::SessionsChanged | Event::SessionRenamed { .. } | Event::SessionChanged { .. }) => {
                self.schedule_discover()
            }
            ClientEvent::Tmux(Event::Exit { reason }) => {
                debug!(host = %self.host, "client {client} exited: {reason:?}");
            }
            ClientEvent::Closed { reason } => {
                debug!(host = %self.host, "client {client} closed: {reason:?}");
                self.clients.remove(&client);
                self.schedule_discover();
            }
            ClientEvent::Tmux(Event::ConfigError(e)) => {
                self.ctx.notice(Some(&self.host), NoticeLevel::Warning, format!("tmux config error: {e}"));
            }
            ClientEvent::Tmux(_) => {}
        }
    }

    /// Called every ~200ms: debounced relists/discovery and tile snapshots.
    pub async fn tick(&mut self) {
        let now = Instant::now();
        if self.discover_due.is_some_and(|d| d <= now)
            // With no control client there are no %sessions-changed notifications; poll.
            || (self.clients.is_empty() && now.duration_since(self.last_discover) > self.idle_poll)
        {
            self.discover().await;
        } else if self.relist_due.is_some_and(|d| d <= now) {
            self.relist().await;
        }
        if self.publish_due {
            self.publish();
        }
        self.activity_heuristics(now);
        for p in self.panes.values_mut() {
            if p.dirty && p.seeding.is_none() && self.ctx.is_visible(p.key) {
                p.dirty = false;
                self.ctx.sink.frame(frames::encode(frames::TILE, p.key, &p.term.snapshot()));
            }
        }
    }

    /// Checks the connection is really alive (e.g. after resume from sleep).
    pub async fn probe(&self) -> bool {
        match self.any_client() {
            Some(client) => {
                matches!(tokio::time::timeout(Duration::from_secs(4), client.command("display-message -p ok")).await, Ok(Ok(_)))
            }
            None => matches!(
                tokio::time::timeout(Duration::from_secs(6), exec::run(&self.conn, "true", Duration::from_secs(6))).await,
                Ok(Ok(_))
            ),
        }
    }

    pub async fn shutdown(&mut self) {
        for c in self.clients.values() {
            let _ = tokio::time::timeout(Duration::from_millis(500), c.client.detach()).await;
        }
        self.clients.clear();
        self.clear();
    }

    /// Detach without clearing the UI's panes (they show "reconnecting" over their last frame).
    pub async fn shutdown_quiet(&mut self) {
        for c in self.clients.values() {
            let _ = tokio::time::timeout(Duration::from_millis(500), c.client.detach()).await;
        }
        self.clients.clear();
    }

    pub fn clear(&mut self) {
        self.panes.clear();
        self.ctx.set_panes(&self.host, Vec::new());
    }

    /// Marks every pane dirty so the next tick re-sends all tiles (e.g. after the UI reloads).
    pub fn resend_all(&mut self) {
        for p in self.panes.values_mut() {
            p.dirty = true;
        }
    }

    fn label(&self, p: &Pane) -> PaneLabel {
        let r = &p.row;
        let detected = Harness::detect(&r.current_command, r.chm_harness.as_deref());
        let cleaned = r.title.trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
        // Shells title themselves with the hostname or user@host:path — not useful labels.
        let title = if matches!(detected, Some(Harness::Shell) | None) || cleaned.is_empty() || cleaned.contains('@') {
            r.window_name.clone()
        } else {
            cleaned.chars().take(60).collect()
        };
        let harness = match detected {
            Some(Harness::Claude) => "Claude Code",
            Some(Harness::Codex) => "Codex",
            Some(Harness::Omp) => "omp",
            Some(Harness::Pi) => "pi",
            Some(Harness::Opencode) => "opencode",
            Some(Harness::Gemini) => "Gemini",
            Some(Harness::Shell) | None => "the shell",
        };
        PaneLabel { title, harness: harness.into(), host: self.host.clone() }
    }

    /// A hook event from the host's events.jsonl. Returns whether it raised an alert.
    pub fn on_hook(&mut self, ev: &crate::integration::events::HookEvent, stale: bool) -> bool {
        let Some(id) = ev.pane.strip_prefix('%').and_then(|n| n.parse::<PaneId>().ok()) else { return false };
        let Some(p) = self.panes.get(&id) else { return false };
        if let Some((event, ts)) = self.last_hook.get(&id)
            && *event == ev.event
            && ev.ts.abs_diff(*ts) <= 1
        {
            return false;
        }
        self.last_hook.insert(id, (ev.event.clone(), ev.ts));
        let sig = Signal { event: ev.event.clone(), detail: ev.detail.clone(), ts: ev.ts, heuristic: false };
        let (key, label) = (p.key, self.label(p));
        self.ctx.signal(key, &sig, &label, stale)
    }

    /// Fallback for agent panes without hooks: sustained output = working; a long silence
    /// after that = probably finished.
    fn activity_heuristics(&mut self, now: Instant) {
        let mut signals = Vec::new();
        for p in self.panes.values_mut() {
            let agent = matches!(
                Harness::detect(&p.row.current_command, p.row.chm_harness.as_deref()),
                Some(h) if h != Harness::Shell
            );
            if !agent || self.ctx.attention.lock().unwrap().has_hooks(p.key) {
                continue;
            }
            let (Some(last), Some(burst)) = (p.last_output, p.burst_start) else { continue };
            if !p.heuristic_working && now.duration_since(last) < Duration::from_millis(1500) && now.duration_since(burst) > Duration::from_secs(4) {
                p.heuristic_working = true;
                signals.push((p.key, "HeuristicWorking"));
            } else if p.heuristic_working && now.duration_since(last) > Duration::from_secs(7) {
                p.heuristic_working = false;
                signals.push((p.key, "HeuristicIdle"));
            }
        }
        for (key, event) in signals {
            let Some(p) = self.panes.values().find(|p| p.key == key) else { continue };
            let label = self.label(p);
            let sig = Signal { event: event.into(), detail: String::new(), ts: 0, heuristic: true };
            self.ctx.signal(key, &sig, &label, false);
        }
    }

    pub fn set_home(&mut self, home: Option<String>) {
        self.home = home;
    }

    /// Deploys the hook assets once per connection. `None` if that failed (launching without
    /// hooks still works; notifications fall back to heuristics).
    pub async fn ensure_assets(&mut self) -> Option<Assets> {
        let home = self.home.clone()?;
        if self.assets.is_none() {
            match assets::ensure(&self.conn, &home, self.server.bin.as_deref()).await {
                Ok(a) => self.assets = Some(a),
                Err(e) => self.ctx.notice(Some(&self.host), NoticeLevel::Warning, format!("Couldn't install hooks: {e}")),
            }
        }
        self.assets.clone()
    }

    /// Creates a window (in a new session by default), types the harness launch command
    /// into its shell, and returns the new pane's key.
    pub async fn create_pane(&mut self, spec: NewPaneSpec) -> Result<u32, String> {
        self.home.as_ref().ok_or("host details unknown (still connecting?)")?;
        let assets = self.ensure_assets().await;
        let launch = spec.harness.launch_command(assets.as_ref(), spec.args.as_deref().unwrap_or(""));

        let base = spec
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| {
                let dir = spec.cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("agent");
                if spec.harness == Harness::Shell { dir.to_string() } else { format!("{dir}-{}", spec.harness.name()) }
            });
        let window = sanitize_name(&base);
        let chm_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let t = self.server.prefix();
        let q = exec::sh_quote;

        let mut script = String::from("set -e\n");
        // tmux silently falls back to $HOME for a missing -c directory; fail loudly instead.
        script += &format!("[ -d {cwd} ] || {{ echo \"no such directory: \"{cwd} >&2; exit 3; }}\n", cwd = q(&spec.cwd));
        match &spec.session {
            Some(session) => {
                script += &format!(
                    "p=$({t} new-window -d -t {} -c {} -n {} -P -F '#{{pane_id}}')\n",
                    q(&format!("{session}:")),
                    q(&spec.cwd),
                    q(&window)
                );
            }
            None => {
                let existing: Vec<String> = self.list_sessions().await.unwrap_or_default().into_iter().map(|s| s.name).collect();
                let mut name = window.clone();
                let mut n = 2;
                while existing.contains(&name) {
                    name = format!("{window}-{n}");
                    n += 1;
                }
                // A placeholder window lets us raise history-limit before the real pane exists
                // (it only applies to panes created afterwards).
                script += &format!("{t} new-session -d -s {s} -x 160 -y 48 -n chm-init\n", s = q(&name));
                script += &format!("{t} set-option -t {} history-limit 50000\n", q(&format!("{name}:")));
                script += &format!(
                    "p=$({t} new-window -d -t {} -c {} -n {} -P -F '#{{pane_id}}')\n",
                    q(&format!("{name}:")),
                    q(&spec.cwd),
                    q(&window)
                );
                script += &format!("{t} kill-window -t {}\n", q(&format!("{name}:chm-init")));
            }
        }
        script += &format!("{t} set-option -p -t \"$p\" @chm_id {}\n", q(&chm_id));
        script += &format!("{t} set-option -p -t \"$p\" @chm_harness {}\n", q(spec.harness.name()));
        if let Some(cmd) = &launch {
            script += &format!("{t} send-keys -t \"$p\" -l -- {}\n{t} send-keys -t \"$p\" Enter\n", q(cmd));
        }
        script += "printf '%s\\n' \"$p\"\n";

        let out = exec::run(&self.conn, &script, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
        if !out.success() {
            return Err(format!("tmux failed: {}", out.stderr_str().trim()));
        }
        let pane: PaneId = out
            .stdout_str()
            .lines()
            .rev()
            .find_map(|l| l.trim().strip_prefix('%').and_then(|n| n.parse().ok()))
            .ok_or("tmux didn't report the new pane")?;
        info!(host = %self.host, "created pane %{pane} ({})", spec.harness.name());
        self.discover().await;
        self.panes.get(&pane).map(|p| p.key).ok_or_else(|| "the new pane didn't show up".to_string())
    }

    /// Makes the pane `cols`×`rows` by pinning its window's size. For a split window the window
    /// grows or shrinks by the difference and the pane is then resized within it.
    async fn resize(&mut self, key: u32, cols: u16, rows: u16) -> Result<ResizeOutcome, String> {
        let (id, client) = self.pane_by_key(key).ok_or("pane not found")?;
        let row = self.panes.get(&id).map(|p| p.row.clone()).ok_or("pane not found")?;
        let (cols, rows) = (cols.clamp(20, 1000), rows.clamp(5, 500));
        let window = quote(&format!("@{}", row.window));
        let pane = quote(&format!("%{id}"));

        let mut cmds: Vec<String> = Vec::new();
        if !row.sized {
            // Remember the window's own window-size (usually unset) so release can restore it.
            let prev = client
                .command(&format!("show-options -wqv -t {window} window-size"))
                .await
                .map(|r| r.text().trim().to_string())
                .unwrap_or_default();
            cmds.push(format!("set-option -w -t {window} @chm_prev_wsize {}", quote(if prev.is_empty() { "-" } else { &prev })));
            cmds.push(format!("set-option -w -t {window} @chm_sized 1"));
        }
        if row.window_panes <= 1 {
            cmds.push(format!("resize-window -t {window} -x {cols} -y {rows}"));
        } else {
            let w = (row.window_width as i32 + cols as i32 - row.width as i32).max(cols as i32);
            let h = (row.window_height as i32 + rows as i32 - row.height as i32).max(rows as i32);
            cmds.push(format!("resize-window -t {window} -x {w} -y {h}"));
            cmds.push(format!("resize-pane -t {pane} -x {cols} -y {rows}"));
        }
        let n = cmds.len();
        let prefix = cmds.join(" ; ");

        // Other (non-control) clients looking at this session or its group: they'll see a
        // cropped/padded window while it's pinned.
        let others = client
            .command(&format!("list-clients -F {}", quote("#{client_control_mode}|~|#{session_group}|~|#{session_name}")))
            .await
            .map(|r| {
                r.lines
                    .iter()
                    .map(|l| String::from_utf8_lossy(l).into_owned())
                    .filter(|l| {
                        let f: Vec<&str> = l.splitn(3, SEP_STR).collect();
                        f.len() == 3
                            && f[0] != "1"
                            && match &row.session_group {
                                Some(g) => f[1] == g,
                                None => f[2] == row.session_name,
                            }
                    })
                    .count() as u32
            })
            .unwrap_or(0);

        if let Some(p) = self.panes.get_mut(&id) {
            p.row.sized = true;
        }
        // Resize and re-capture in one line: the streaming view gets a RESET at the new size
        // and never sees output drawn for the old width.
        self.seed_after(id, Some((prefix, n))).await;
        self.schedule_relist();
        Ok(ResizeOutcome { other_clients: others })
    }

    async fn release_size(&mut self, key: u32) -> Result<(), String> {
        let (id, client) = self.pane_by_key(key).ok_or("pane not found")?;
        let row = self.panes.get(&id).map(|p| p.row.clone()).ok_or("pane not found")?;
        if !row.sized {
            return Ok(()); // never touch windows we didn't pin
        }
        let window = quote(&format!("@{}", row.window));
        let prev = client
            .command(&format!("show-options -wqv -t {window} @chm_prev_wsize"))
            .await
            .map(|r| r.text().trim().to_string())
            .unwrap_or_default();
        let restore = if prev.is_empty() || prev == "-" {
            format!("set-option -wu -t {window} window-size")
        } else {
            format!("set-option -w -t {window} window-size {}", quote(&prev))
        };
        let line = format!("{restore} ; set-option -wu -t {window} @chm_sized ; set-option -wu -t {window} @chm_prev_wsize");
        client.commands(&line, 3).await.map_err(|e| e.to_string())?;
        if let Some(p) = self.panes.get_mut(&id) {
            p.row.sized = false;
        }
        self.schedule_relist();
        Ok(())
    }

    /// The UI (re)subscribed and has no expanded panes yet.
    pub fn stop_streams(&mut self) {
        self.ctx.streaming.lock().unwrap().clear();
        for p in self.panes.values_mut() {
            p.streaming = false;
        }
    }

    fn pane_by_key(&self, key: u32) -> Option<(PaneId, Arc<ControlClient>)> {
        let (id, p) = self.panes.iter().find(|(_, p)| p.key == key)?;
        let client = self.clients.get(&p.client)?.client.clone();
        Some((*id, client))
    }

    pub async fn pane_cmd(&mut self, cmd: PaneCmd) {
        match cmd {
            PaneCmd::Stream { key, on } => {
                {
                    let mut streaming = self.ctx.streaming.lock().unwrap();
                    if on {
                        streaming.insert(key);
                    } else {
                        streaming.remove(&key);
                    }
                }
                let Some((id, client)) = self.pane_by_key(key) else { return };
                let Some(p) = self.panes.get_mut(&id) else { return };
                p.streaming = on;
                if on && p.row.chm_id.is_none() {
                    // Give the pane a stable identity for per-pane preferences (survives window
                    // renumbering and is shared across devices).
                    let chm_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
                    let line = format!("set-option -p -t {} @chm_id {}", quote(&format!("%{id}")), quote(&chm_id));
                    if client.command(&line).await.is_ok() {
                        p.row.chm_id = Some(chm_id);
                        self.publish_due = true;
                    }
                }
                if on {
                    // Always (re)seed: the UI needs a RESET to (re)build its terminal.
                    self.seed(id).await;
                }
            }
            PaneCmd::Keys { key, keys } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                if keys.is_empty() {
                    return;
                }
                let mut words = vec!["send-keys".to_string(), "-t".into(), format!("%{id}")];
                words.extend(keys);
                if let Err(e) = client.command(&crate::tmux::quote::cmd(&words)).await {
                    debug!(host = %self.host, "send-keys to %{id} failed: {e}");
                }
            }
            PaneCmd::Text { key, text } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                for chunk in chunk_str(&text, 2048) {
                    let line = crate::tmux::quote::cmd(&["send-keys", "-t", &format!("%{id}"), "-l", "--", chunk]);
                    if let Err(e) = client.command(&line).await {
                        debug!(host = %self.host, "send-keys -l to %{id} failed: {e}");
                        return;
                    }
                }
            }
            PaneCmd::Input { key, data } => {
                // tmux panes take keys, not raw bytes; this is only reached for plain text.
                Box::pin(self.pane_cmd(PaneCmd::Text { key, text: String::from_utf8_lossy(&data).into_owned() })).await;
            }
            PaneCmd::Paste { key, text } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                if let Err(e) = paste(&client, id, &text).await {
                    self.ctx.notice(Some(&self.host), NoticeLevel::Error, format!("Paste failed: {e}"));
                }
            }
            PaneCmd::Submit { key, text } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                let harness = self.panes.get(&id).and_then(|p| Harness::detect(&p.row.current_command, p.row.chm_harness.as_deref()));
                let ctx = self.ctx.clone();
                let host = self.host.clone();
                tokio::spawn(async move {
                    if let Err(e) = submit(&client, id, &text, harness).await {
                        ctx.notice(Some(&host), NoticeLevel::Error, format!("Couldn't send prompt: {e}"));
                    }
                });
            }
            PaneCmd::Resize { key, cols, rows, reply } => {
                let _ = reply.send(self.resize(key, cols, rows).await);
            }
            PaneCmd::ReleaseSize { key } => {
                if let Err(e) = self.release_size(key).await {
                    self.ctx.notice(Some(&self.host), NoticeLevel::Warning, format!("Couldn't release size: {e}"));
                }
            }
            PaneCmd::SetLabels { key, labels } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                let target = quote(&format!("%{id}"));
                let mut seen = std::collections::HashSet::new();
                let labels: Vec<String> =
                    labels.into_iter().filter(|l| !l.trim().is_empty() && !l.contains(',') && seen.insert(l.clone())).collect();
                let line = if labels.is_empty() {
                    format!("set-option -p -u -t {target} @chm_labels")
                } else {
                    format!("set-option -p -t {target} @chm_labels {}", quote(&labels.join(",")))
                };
                if let Err(e) = client.command(&line).await {
                    self.ctx.notice(Some(&self.host), NoticeLevel::Error, format!("Couldn't label pane: {e}"));
                    return;
                }
                if let Some(p) = self.panes.get_mut(&id) {
                    p.row.labels = labels;
                }
                self.publish();
            }
            PaneCmd::SetBell { key, bell } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                let target = quote(&format!("%{id}"));
                let line = match bell {
                    Some(on) => format!("set-option -p -t {target} @chm_bell {}", if on { 1 } else { 0 }),
                    None => format!("set-option -p -u -t {target} @chm_bell"),
                };
                if let Err(e) = client.command(&line).await {
                    self.ctx.notice(Some(&self.host), NoticeLevel::Error, format!("Couldn't update pane: {e}"));
                    return;
                }
                if let Some(p) = self.panes.get_mut(&id) {
                    p.row.bell = bell;
                }
                self.publish();
            }
            PaneCmd::Hide { key, hidden } => {
                let Some((id, client)) = self.pane_by_key(key) else { return };
                let target = quote(&format!("%{id}"));
                let line = if hidden {
                    format!("set-option -p -t {target} @chm_hidden 1")
                } else {
                    format!("set-option -p -u -t {target} @chm_hidden")
                };
                if let Err(e) = client.command(&line).await {
                    self.ctx.notice(Some(&self.host), NoticeLevel::Error, format!("Couldn't update pane: {e}"));
                }
                if let Some(p) = self.panes.get_mut(&id) {
                    p.row.chm_hidden = hidden;
                }
                self.publish();
            }
            PaneCmd::Terminate { key, force, reply } => {
                let Some((id, client)) = self.pane_by_key(key) else {
                    let _ = reply.send(Ok(TerminateOutcome::Closed));
                    return;
                };
                let harness = self.panes.get(&id).and_then(|p| Harness::detect(&p.row.current_command, p.row.chm_harness.as_deref()));
                // Quitting can take seconds; don't block tile updates while it runs.
                tokio::spawn(async move {
                    let _ = reply.send(terminate(&client, id, harness, force).await);
                });
            }
        }
    }
}

/// Pastes a prompt (bracketed, so newlines don't submit early) and presses Enter.
///
/// The pause matters: Codex treats keystrokes arriving within ~120 ms of a paste burst as
/// part of the paste, and Claude Code needs a beat to collapse large pastes.
async fn submit(client: &ControlClient, pane: PaneId, text: &str, harness: Option<Harness>) -> Result<(), crate::tmux::TmuxError> {
    let text = text.trim_end_matches(['\n', '\r']);
    if text.is_empty() {
        return Ok(());
    }
    paste(client, pane, text).await?;
    let settle = match harness {
        Some(Harness::Codex) => 350,
        _ if text.len() > 800 || text.contains('\n') => 300,
        _ => 180,
    };
    tokio::time::sleep(Duration::from_millis(settle)).await;
    client.command(&format!("send-keys -t {} Enter", quote(&format!("%{pane}")))).await?;
    Ok(())
}

/// tmux session/window names: keep them shell- and target-friendly.
fn sanitize_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() { "agent".into() } else { trimmed.chars().take(40).collect() }
}

async fn current_command(client: &ControlClient, pane: PaneId) -> Option<String> {
    let reply = client
        .command(&format!("display-message -p -t {} '#{{pane_current_command}}'", quote(&format!("%{pane}"))))
        .await
        .ok()?;
    Some(reply.text().trim().to_string())
}

/// Graceful quit: interrupt, type the harness's quit command, wait for the shell to come
/// back, then kill the pane. A single Escape only — Esc-Esc opens Claude Code's rewind menu.
async fn terminate(
    client: &ControlClient,
    pane: PaneId,
    harness: Option<Harness>,
    force: bool,
) -> Result<TerminateOutcome, String> {
    let target = quote(&format!("%{pane}"));
    if !force {
        let Some(cmd) = current_command(client, pane).await else { return Ok(TerminateOutcome::Closed) };
        let is_shell = Harness::from_name(cmd.trim_start_matches('-')) == Some(Harness::Shell);
        match harness.and_then(Harness::quit_command) {
            Some(quit) if !is_shell => {
                let _ = client.command(&format!("send-keys -t {target} Escape")).await;
                tokio::time::sleep(Duration::from_millis(400)).await;
                let _ = client.command(&crate::tmux::quote::cmd(&["send-keys", "-t", &format!("%{pane}"), "-l", "--", quit])).await;
                tokio::time::sleep(Duration::from_millis(200)).await;
                let _ = client.command(&format!("send-keys -t {target} Enter")).await;
                let mut exited = false;
                for _ in 0..48 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    match current_command(client, pane).await {
                        None => return Ok(TerminateOutcome::Closed),
                        Some(c) if Harness::from_name(c.trim_start_matches('-')) == Some(Harness::Shell) => {
                            exited = true;
                            break;
                        }
                        Some(_) => {}
                    }
                }
                if !exited {
                    let command = current_command(client, pane).await.unwrap_or_default();
                    return Ok(TerminateOutcome::StillRunning { command });
                }
            }
            _ if !is_shell => return Ok(TerminateOutcome::StillRunning { command: cmd }),
            _ => {}
        }
    }
    match client.command(&format!("kill-pane -t {target}")).await {
        Ok(_) => Ok(TerminateOutcome::Closed),
        Err(e) if e.to_string().contains("can't find") => Ok(TerminateOutcome::Closed),
        Err(e) => Err(e.to_string()),
    }
}

/// Splits `s` into chunks of at most `max` bytes on char boundaries.
fn chunk_str(s: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < s.len() {
        let mut end = (start + max).min(s.len());
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            // A single character wider than `max`: take it whole.
            end = start + s[start..].chars().next().map_or(1, char::len_utf8);
        }
        out.push(&s[start..end]);
        start = end;
    }
    out
}

/// Loads `text` into a uniquely named tmux buffer and pastes it into the pane. `-p` makes
/// tmux wrap it in bracketed-paste markers only if the application enabled them.
pub(crate) async fn paste(client: &ControlClient, pane: PaneId, text: &str) -> Result<(), crate::tmux::TmuxError> {
    if text.is_empty() {
        return Ok(());
    }
    let buffer = format!("chm-{}", uuid::Uuid::new_v4().simple());
    for (i, chunk) in chunk_str(text, 16 * 1024).into_iter().enumerate() {
        let append = if i == 0 { "" } else { "-a " };
        client.command(&format!("set-buffer {append}-b {buffer} -- {}", quote(chunk))).await?;
    }
    client
        .command(&format!("paste-buffer -p -d -b {buffer} -t {}", quote(&format!("%{pane}"))))
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{chunk_str, sanitize_name};

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name("terrarium-annotator-claude"), "terrarium-annotator-claude");
        assert_eq!(sanitize_name("my proj.v2:claude"), "my-proj-v2-claude");
        assert_eq!(sanitize_name("..."), "agent");
    }

    #[test]
    fn chunks_respect_char_boundaries() {
        let s = "aé日🎉b";
        let chunks = chunk_str(s, 3);
        assert_eq!(chunks.concat(), s);
        assert!(chunks.iter().all(|c| c.len() <= 4));
    }
}
