//! The public entry point: [`Core`] owns host actors, the tailnet poller and the
//! resume detector, and pushes everything to a [`Sink`].

pub mod attention;
mod ctx;
mod direct;
pub mod frames;
mod host;
mod tmux_mgr;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::oneshot;
use tracing::{info, warn};

pub use ctx::Sink;
use ctx::Ctx;
use host::{HostCmd, HostHandle, IntegrationAction};
use tmux_mgr::PaneCmd;

use crate::harness::Harness;
use crate::local::{self, LOCAL_HOST, LocalShell};
use crate::model::{
    AppConfig, CoreEvent, CoreSnapshot, DirListing, FocusState, HostConfig, HostId, HostPhase, LabelDef, NewPaneSpec, NoticeLevel,
    ResizeOutcome, SoundPrefs, TailnetStatus, TerminateOutcome, UiPrefs, label_slug,
};

/// Loads config.json. A file that exists but can't be parsed is set aside (never silently
/// overwritten), so a bad edit or a future format can't cost the user their machines.
fn load_config(path: &std::path::Path) -> AppConfig {
    let Ok(bytes) = std::fs::read(path) else { return AppConfig::default() };
    match serde_json::from_slice(&bytes) {
        Ok(cfg) => cfg,
        Err(e) => {
            let ts = SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let backup = path.with_extension(format!("json.unreadable-{ts}"));
            warn!("{} is unreadable ({e}); moved it to {}", path.display(), backup.display());
            let _ = std::fs::rename(path, &backup);
            AppConfig::default()
        }
    }
}
use crate::ssh::exec::ExecOutput;
use crate::ssh::hostkeys::KnownHosts;

type GitResult = Result<Option<crate::fs::git::GitStatus>, String>;
type GitFuture = futures::future::Shared<futures::future::BoxFuture<'static, GitResult>>;

pub struct Core {
    ctx: Arc<Ctx>,
    /// In-flight `git status` per (host, dir): concurrent callers share one run.
    git_inflight: Mutex<HashMap<(HostId, String), GitFuture>>,
    data_dir: PathBuf,
    config: Mutex<AppConfig>,
    hosts: Mutex<HashMap<HostId, HostHandle>>,
    /// Captured in [`Core::start`] so the public API can be called from any thread (Tauri
    /// runs synchronous commands on the main thread, outside the runtime).
    rt: OnceLock<tokio::runtime::Handle>,
}

impl Core {
    /// Loads config from `data_dir`. Call [`Core::start`] from within a tokio runtime.
    pub fn new(data_dir: PathBuf, sink: Arc<dyn Sink>) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&data_dir);
        let known_hosts = Arc::new(KnownHosts::load(data_dir.join("known_hosts.json")));
        let config = load_config(&data_dir.join("config.json"));
        Arc::new(Self {
            ctx: Arc::new(Ctx::new(sink, known_hosts)),
            git_inflight: Mutex::new(HashMap::new()),
            data_dir,
            config: Mutex::new(config),
            hosts: Mutex::new(HashMap::new()),
            rt: OnceLock::new(),
        })
    }

    fn rt(&self) -> tokio::runtime::Handle {
        self.rt
            .get()
            .cloned()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
            .expect("Core::start must be called (inside a tokio runtime) before using Core")
    }

    /// Starts background work. Must be called from within a tokio runtime; afterwards every
    /// method is safe to call from any thread.
    pub fn start(self: &Arc<Self>) {
        let rt = self.rt.get_or_init(tokio::runtime::Handle::current).clone();
        // This PC: always there, always connected. Hooks of agents in local shells report
        // through the local events file.
        self.ctx.set_phase(LOCAL_HOST, HostPhase::Connected);
        let ctx = self.ctx.clone();
        rt.spawn(async move {
            let facts = tokio::task::spawn_blocking(local::facts).await.ok();
            ctx.set_facts(LOCAL_HOST, facts);
        });
        let ctx = self.ctx.clone();
        rt.spawn(local::tail_events(Arc::new(move |line: &str| {
            if let Ok(event) = serde_json::from_str::<crate::integration::events::HookEvent>(line) {
                direct::route_hook(&ctx, &event, false);
            }
        })));

        // Tailnet first, so host actors can resolve addresses and pinned keys.
        let core = self.clone();
        rt.spawn(async move {
            core.refresh_tailnet().await;
            let hosts = core.config.lock().unwrap().hosts.clone();
            for cfg in hosts {
                core.spawn_host(cfg);
            }
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.tick().await;
            loop {
                interval.tick().await;
                core.refresh_tailnet().await;
            }
        });

        // Resume-from-sleep detection: a 5 s timer that observes a large wall-clock jump.
        let core = self.clone();
        rt.spawn(async move {
            let mut last_wall = SystemTime::now();
            let mut last_mono = Instant::now();
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let wall = SystemTime::now();
                let mono = Instant::now();
                let wall_delta = wall.duration_since(last_wall).unwrap_or_default();
                let mono_delta = mono.duration_since(last_mono);
                if wall_delta > mono_delta + Duration::from_secs(20) || wall_delta > Duration::from_secs(60) {
                    info!("wall clock jumped {:?} (sleep/resume?)", wall_delta);
                    core.notify_resumed();
                }
                last_wall = wall;
                last_mono = mono;
            }
        });
    }

    fn spawn_host(&self, cfg: HostConfig) {
        let id = cfg.id.clone();
        let handle = host::spawn(cfg, self.ctx.clone(), &self.rt());
        if let Some(old) = self.hosts.lock().unwrap().insert(id, handle) {
            old.send(HostCmd::Shutdown);
        }
    }

    fn save_config(&self) {
        let config = self.config.lock().unwrap().clone();
        let path = self.data_dir.join("config.json");
        let tmp = path.with_extension("json.tmp");
        match serde_json::to_vec_pretty(&config) {
            Ok(bytes) => {
                if std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
                    warn!("failed to save {}", path.display());
                }
            }
            Err(e) => warn!("failed to serialise config: {e}"),
        }
        self.ctx.emit(CoreEvent::Config { config });
    }

    pub fn snapshot(&self) -> CoreSnapshot {
        CoreSnapshot {
            tailnet: self.ctx.tailnet.read().unwrap().clone(),
            config: self.config.lock().unwrap().clone(),
            hosts: self.ctx.host_states.lock().unwrap().values().cloned().collect(),
            panes: self.ctx.panes.lock().unwrap().values().flatten().cloned().collect(),
            attention: self.ctx.attention.lock().unwrap().all(),
        }
    }

    pub async fn refresh_tailnet(&self) -> TailnetStatus {
        let status = crate::tailscale::fetch_status().await;
        let changed = {
            let mut current = self.ctx.tailnet.write().unwrap();
            let changed = *current != status;
            *current = status.clone();
            changed
        };
        if changed {
            self.ctx.emit(CoreEvent::Tailnet { status: status.clone() });
        }
        status
    }

    /// Adds or updates a host. New hosts with `auto_connect` start connecting immediately.
    pub fn upsert_host(&self, cfg: HostConfig) {
        let existed = {
            let mut config = self.config.lock().unwrap();
            match config.hosts.iter_mut().find(|h| h.id == cfg.id) {
                Some(h) => {
                    *h = cfg.clone();
                    true
                }
                None => {
                    config.hosts.push(cfg.clone());
                    false
                }
            }
        };
        self.save_config();
        let hosts = self.hosts.lock().unwrap();
        match hosts.get(&cfg.id) {
            Some(h) if existed => h.send(HostCmd::Reconfigure(cfg)),
            _ => {
                drop(hosts);
                self.spawn_host(cfg);
            }
        }
    }

    pub fn remove_host(&self, id: &str) {
        self.config.lock().unwrap().hosts.retain(|h| h.id != id);
        self.save_config();
        if let Some(h) = self.hosts.lock().unwrap().remove(id) {
            h.send(HostCmd::Shutdown);
        }
        for d in self.ctx.direct.lock().unwrap().values().filter(|d| d.info.host == id) {
            let _ = d.tx.send(direct::DirectMsg::Close);
        }
        self.ctx.remove_host(id);
    }

    fn send(&self, id: &str, cmd: HostCmd) {
        if let Some(h) = self.hosts.lock().unwrap().get(id) {
            h.send(cmd);
        }
    }

    pub fn connect(&self, id: &str) {
        self.send(id, HostCmd::Connect);
    }

    pub fn disconnect(&self, id: &str) {
        self.send(id, HostCmd::Disconnect);
    }

    /// Drops the connection and reconnects immediately (e.g. after a network change).
    pub fn reconnect(&self, id: &str) {
        self.send(id, HostCmd::Reconnect);
    }

    /// Forget a TOFU host key (after the user confirms a legitimate key change).
    pub fn forget_host_key(&self, id: &str) {
        self.ctx.known_hosts.forget(id);
    }

    /// Resume from sleep or network change: refresh the tailnet and probe every host.
    pub fn notify_resumed(self: &Arc<Self>) {
        let core = self.clone();
        self.rt().spawn(async move {
            // Give Tailscale a moment to re-establish paths.
            tokio::time::sleep(Duration::from_secs(2)).await;
            core.refresh_tailnet().await;
            for h in core.hosts.lock().unwrap().values() {
                h.send(HostCmd::Probe);
            }
        });
    }

    /// Which pane tiles the UI is showing (`None` = all). Hidden panes stop getting frames.
    pub fn set_visible_panes(&self, keys: Option<Vec<u32>>) {
        *self.ctx.visible.write().unwrap() = keys.map(|k| k.into_iter().collect());
        self.resend_tiles();
    }

    /// Re-send every tile (the UI reloaded or re-subscribed).
    pub fn resend_tiles(&self) {
        for h in self.hosts.lock().unwrap().values() {
            h.send(HostCmd::ResendTiles);
        }
        for d in self.ctx.direct.lock().unwrap().values() {
            let _ = d.tx.send(direct::DirectMsg::Resend);
        }
    }

    fn host_of_pane(&self, key: u32) -> Option<HostId> {
        let panes = self.ctx.panes.lock().unwrap();
        panes.iter().find(|(_, list)| list.iter().any(|p| p.key == key)).map(|(h, _)| h.clone())
    }

    /// Sends a pane command to whoever owns the pane (a direct pane's task, or its host's
    /// tmux manager). Returns false if the pane is unknown.
    fn pane(&self, key: u32, cmd: PaneCmd) -> bool {
        if let Some(d) = self.ctx.direct.lock().unwrap().get(&key) {
            return d.tx.send(direct::DirectMsg::Pane(cmd)).is_ok();
        }
        match self.host_of_pane(key) {
            Some(host) => {
                self.send(&host, HostCmd::Pane(cmd));
                true
            }
            None => false,
        }
    }

    /// Expanded view: stream raw output (after a full-history RESET frame), or stop.
    pub fn stream_pane(&self, key: u32, on: bool) {
        self.pane(key, PaneCmd::Stream { key, on });
    }

    /// Sends tmux key names (`Enter`, `C-c`, `Up`, …) to a pane.
    pub fn send_keys(&self, key: u32, keys: Vec<String>) {
        self.pane(key, PaneCmd::Keys { key, keys });
    }

    /// Types literal text into a pane.
    pub fn send_text(&self, key: u32, text: String) {
        self.pane(key, PaneCmd::Text { key, text });
    }

    /// Sends a composer prompt: bracketed paste, a short pause, then Enter.
    pub fn submit_prompt(&self, key: u32, text: String) {
        self.pane(key, PaneCmd::Submit { key, text });
    }

    /// Pastes text into a pane (bracketed paste when the app supports it).
    pub fn paste_text(&self, key: u32, text: String) {
        self.pane(key, PaneCmd::Paste { key, text });
    }

    /// Raw terminal input in the terminal's own encoding (direct panes).
    pub fn send_input(&self, key: u32, data: Vec<u8>) {
        self.pane(key, PaneCmd::Input { key, data });
    }

    pub fn sound_prefs(&self) -> SoundPrefs {
        self.config.lock().unwrap().sound.clone()
    }

    /// Updates notification sound preferences (persisted; emitted as a Config event).
    pub fn set_sound_prefs(&self, prefs: SoundPrefs) {
        self.config.lock().unwrap().sound = prefs;
        self.save_config();
    }

    pub fn ui_prefs(&self) -> UiPrefs {
        self.config.lock().unwrap().ui.clone()
    }

    /// Updates the UI preferences kept in the config (persisted at once; emitted as Config).
    pub fn set_ui_prefs(&self, prefs: UiPrefs) {
        self.config.lock().unwrap().ui = prefs;
        self.save_config();
    }

    /// Creates a label (id derived from the name, made unique) and returns it.
    pub fn create_label(&self, name: &str, color: &str) -> LabelDef {
        let label = {
            let mut config = self.config.lock().unwrap();
            let base = label_slug(name);
            let mut id = base.clone();
            let mut n = 2;
            while config.labels.iter().any(|l| l.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            let label = LabelDef { id, name: name.trim().to_string(), color: color.to_string() };
            config.labels.push(label.clone());
            label
        };
        self.save_config();
        label
    }

    /// Renames/recolours a label (its id never changes).
    pub fn update_label(&self, label: LabelDef) {
        {
            let mut config = self.config.lock().unwrap();
            match config.labels.iter_mut().find(|l| l.id == label.id) {
                Some(l) => *l = label,
                None => return,
            }
        }
        self.save_config();
    }

    /// Deletes a label definition and removes it from every pane that has it (panes on
    /// offline hosts keep the stale id; the UI shows unknown ids muted).
    pub fn delete_label(&self, id: &str) {
        self.config.lock().unwrap().labels.retain(|l| l.id != id);
        self.save_config();
        let affected: Vec<(u32, Vec<String>)> = self
            .ctx
            .panes
            .lock()
            .unwrap()
            .values()
            .flatten()
            .filter(|p| p.labels.iter().any(|l| l == id))
            .map(|p| (p.key, p.labels.iter().filter(|l| *l != id).cloned().collect()))
            .collect();
        for (key, labels) in affected {
            self.set_pane_labels(key, labels);
        }
    }

    pub fn set_pane_labels(&self, key: u32, labels: Vec<String>) {
        self.pane(key, PaneCmd::SetLabels { key, labels });
    }

    /// Ping (or not) when the pane rings the terminal bell; `None` restores the default (on for
    /// chat clients such as irssi).
    pub fn set_pane_bell(&self, key: u32, bell: Option<bool>) {
        self.pane(key, PaneCmd::SetBell { key, bell });
    }

    /// What the user is looking at (drives ping/toast/ack rules).
    pub fn set_focus(&self, focus: FocusState) {
        self.ctx.set_focus(focus);
    }

    /// The user interacted with a pane's tile: stop glowing.
    pub fn ack_pane(&self, key: u32) {
        self.ctx.ack(key);
    }

    pub fn set_pane_muted(&self, key: u32, muted: bool) {
        self.ctx.attention.lock().unwrap().set_muted(key, muted);
    }

    /// Shells that can be started on this machine.
    pub fn local_shells(&self) -> Vec<LocalShell> {
        local::shells()
    }

    /// Drives on this machine (Windows; empty elsewhere).
    pub fn local_drives(&self) -> Vec<local::DriveInfo> {
        local::drives()
    }

    /// Local shells still running (quitting the app ends them).
    pub fn live_local_shells(&self) -> usize {
        self.ctx.direct.lock().unwrap().values().filter(|d| d.info.host == LOCAL_HOST && d.info.ended.is_none()).count()
    }

    /// Starts a shell on this machine (a direct pane), optionally launching a harness in it.
    fn create_local(&self, spec: NewPaneSpec) -> Result<u32, String> {
        let defs = local::shell_defs();
        let def = match spec.shell.as_deref() {
            Some(id) => defs.iter().find(|d| d.shell.id == id).cloned().ok_or_else(|| format!("unknown shell {id}"))?,
            None => defs.first().cloned().ok_or("no shell found on this machine")?,
        };
        let chm_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let agent = spec.harness != Harness::Shell;
        let assets = if agent || local::integration_uses_assets(&def) {
            local::ensure_assets()
                .map_err(|e| {
                    if agent {
                        self.ctx.notice(Some(LOCAL_HOST), NoticeLevel::Warning, format!("Hooks unavailable ({e}); notifications will be guessed from output"))
                    }
                })
                .ok()
        } else {
            None
        };
        let launch = if agent { spec.harness.launch_command_for(assets.as_ref(), spec.args.as_deref().unwrap_or(""), def.quoting) } else { None };
        let cwd = match spec.cwd.as_str() {
            "" | "~" => local::home(),
            c => c.to_string(),
        };
        let (args, extra_env) = local::integrate(&def, assets.as_ref());
        let mut env = local::pane_env(&def, &chm_id);
        env.extend(extra_env);
        let cmd = crate::pty::LocalCommand { program: def.shell.path.clone(), args, cwd: Some(cwd.clone()), env };
        let pty = crate::pty::local(&cmd, host::DIRECT_COLS, host::DIRECT_ROWS)?;
        if let Some(launch) = launch {
            let _ = pty.input.send(crate::pty::PtyInput::Data(format!("{launch}\r").into_bytes()));
        }
        let spec = direct::DirectSpec {
            host: LOCAL_HOST.into(),
            cwd,
            command: def.shell.name.clone(),
            harness: (spec.harness != Harness::Shell).then_some(spec.harness),
            chm_id,
            cols: host::DIRECT_COLS,
            rows: host::DIRECT_ROWS,
        };
        Ok(direct::spawn(&self.ctx, &self.rt(), spec, pty))
    }

    /// Creates a pane running `spec.harness` and returns its key.
    pub async fn create_pane(&self, spec: NewPaneSpec) -> Result<u32, String> {
        if spec.host == LOCAL_HOST {
            return self.create_local(spec);
        }
        let (tx, rx) = oneshot::channel();
        let host = spec.host.clone();
        if !self.hosts.lock().unwrap().contains_key(&host) {
            return Err(format!("unknown host {host}"));
        }
        self.send(&host, HostCmd::CreatePane { spec, reply: tx });
        rx.await.map_err(|_| "host went away".to_string())?
    }

    /// Resizes a pane (pins its tmux window's size).
    pub async fn resize_pane(&self, key: u32, cols: u16, rows: u16) -> Result<ResizeOutcome, String> {
        let (tx, rx) = oneshot::channel();
        if !self.pane(key, PaneCmd::Resize { key, cols, rows, reply: tx }) {
            return Err("pane not found".into());
        }
        rx.await.map_err(|_| "host went away".to_string())?
    }

    /// Returns a pane's window to tmux's automatic sizing (only if we pinned it).
    pub fn release_pane_size(&self, key: u32) {
        self.pane(key, PaneCmd::ReleaseSize { key });
    }

    pub fn set_pane_hidden(&self, key: u32, hidden: bool) {
        self.pane(key, PaneCmd::Hide { key, hidden });
    }

    /// Gracefully quits the pane's harness and closes it (or kills it with `force`).
    pub async fn terminate_pane(&self, key: u32, force: bool) -> Result<TerminateOutcome, String> {
        let (tx, rx) = oneshot::channel();
        if !self.pane(key, PaneCmd::Terminate { key, force, reply: tx }) {
            return Ok(TerminateOutcome::Closed);
        }
        rx.await.map_err(|_| "host went away".to_string())?
    }

    async fn integration(&self, host: &str, action: IntegrationAction) -> Result<crate::integration::install::IntegrationStatus, String> {
        if host == LOCAL_HOST {
            use crate::integration::install;
            let home = local::home();
            return match action {
                IntegrationAction::Status => Ok(install::local_status(&home).await),
                IntegrationAction::Install => install::local_install(&home, &local::ensure_assets()?).await,
                IntegrationAction::Uninstall => install::local_uninstall(&home).await,
            };
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::Integration { action, reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// Whether hand-started sessions on `host` report to Consuls (global hooks).
    pub async fn integration_status(&self, host: &str) -> Result<crate::integration::install::IntegrationStatus, String> {
        self.integration(host, IntegrationAction::Status).await
    }

    pub async fn install_integration(&self, host: &str) -> Result<crate::integration::install::IntegrationStatus, String> {
        self.integration(host, IntegrationAction::Install).await
    }

    pub async fn uninstall_integration(&self, host: &str) -> Result<crate::integration::install::IntegrationStatus, String> {
        self.integration(host, IntegrationAction::Uninstall).await
    }

    pub async fn list_dir(&self, host: &str, path: &str) -> Result<DirListing, String> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || local::list_dir(&path)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::ListDir { path: path.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// Creates, renames or deletes files (explorer actions).
    pub async fn fs_op(&self, host: &str, op: crate::fs::FsOp) -> Result<(), String> {
        if host == LOCAL_HOST {
            return tokio::task::spawn_blocking(move || crate::fs::local::op(op)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::Fs { op, reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// How many items a delete of `path` would remove (capped; for the confirmation).
    pub async fn fs_count(&self, host: &str, path: &str) -> Result<u64, String> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || crate::fs::local::count(&path)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::FsCount { path: path.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// Reads a file for the editor (text, or why it can't be edited).
    pub async fn read_file(&self, host: &str, path: &str) -> Result<crate::fs::FileContent, String> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || crate::fs::local::read(&path)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::ReadFile { path: path.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// A file's committed version (HEAD), for the editor's change gutter.
    pub async fn git_head(&self, host: &str, path: &str) -> Result<crate::fs::git::HeadVersion, String> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || crate::fs::local::git_head(&path)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::GitHead { path: path.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// A file's raw bytes (image preview; capped at 20 MB).
    pub async fn read_bytes(&self, host: &str, path: &str) -> Result<Vec<u8>, String> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || crate::fs::local::read_bytes(&path)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::ReadBytes { path: path.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// Size and mtime of a file (None if it doesn't exist), to notice outside changes.
    pub async fn stat_file(&self, host: &str, path: &str) -> Result<Option<crate::fs::FileStamp>, String> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || crate::fs::local::stat(&path)).await.map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::StatFile { path: path.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }

    /// Saves editor text. With `expect`, refuses if the file changed since it was read.
    pub async fn write_file(
        &self,
        host: &str,
        path: &str,
        text: String,
        bom: bool,
        expect: Option<crate::fs::FileStamp>,
    ) -> Result<crate::fs::FileStamp, crate::fs::SaveError> {
        if host == LOCAL_HOST {
            let path = path.to_string();
            return tokio::task::spawn_blocking(move || crate::fs::local::write(&path, &text, bom, expect))
                .await
                .map_err(|e| crate::fs::SaveError::Failed { message: e.to_string() })?;
        }
        let (tx, rx) = oneshot::channel();
        self.send(host, HostCmd::WriteFile { path: path.to_string(), text, bom, expect, reply: tx });
        rx.await.map_err(|_| crate::fs::SaveError::Failed { message: "host not found".into() })?
    }

    /// `git status` of the repository containing `dir` (None when it isn't in one).
    /// Concurrent requests for the same folder share one run.
    pub async fn git_status(&self, host: &str, dir: &str) -> GitResult {
        use futures::FutureExt;
        let key = (host.to_string(), dir.to_string());
        let fut = {
            let mut inflight = self.git_inflight.lock().unwrap();
            if let Some(f) = inflight.get(&key) {
                f.clone()
            } else {
                let fut: futures::future::BoxFuture<'static, GitResult> = if host == LOCAL_HOST {
                    let dir = dir.to_string();
                    async move { tokio::task::spawn_blocking(move || crate::fs::local::git_status(&dir)).await.map_err(|e| e.to_string())? }.boxed()
                } else {
                    let (tx, rx) = oneshot::channel();
                    self.send(host, HostCmd::Git { dir: dir.to_string(), reply: tx });
                    async move { rx.await.map_err(|_| "host not found".to_string())? }.boxed()
                };
                let shared = fut.shared();
                inflight.insert(key.clone(), shared.clone());
                shared
            }
        };
        let result = fut.await;
        self.git_inflight.lock().unwrap().remove(&key);
        result
    }

    pub async fn exec(&self, id: &str, script: &str) -> Result<ExecOutput, String> {
        let (tx, rx) = oneshot::channel();
        self.send(id, HostCmd::Exec { script: script.to_string(), reply: tx });
        rx.await.map_err(|_| "host not found".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Collect(Mutex<Vec<CoreEvent>>);
    impl Sink for Collect {
        fn event(&self, event: CoreEvent) {
            self.0.lock().unwrap().push(event);
        }
        fn frame(&self, _frame: Vec<u8>) {}
    }

    #[test]
    fn unreadable_config_is_set_aside_not_lost() {
        let dir = std::env::temp_dir().join(format!("chm-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, b"{ this is not json").unwrap();
        let cfg = load_config(&path);
        assert!(cfg.hosts.is_empty());
        assert!(!path.exists(), "bad file moved aside");
        let kept = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().contains("unreadable"));
        assert!(kept, "backup kept");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Tauri runs synchronous commands on the main thread, outside the tokio runtime; the
    /// public API must work from there (regression: adding a machine used to panic).
    #[test]
    fn api_is_callable_outside_the_runtime() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = std::env::temp_dir().join(format!("chm-core-test-{}", std::process::id()));
        let sink = Arc::new(Collect(Mutex::new(Vec::new())));
        let core = Core::new(dir.clone(), sink.clone());
        rt.block_on(async { core.start() });

        // This thread is not a runtime thread.
        assert!(tokio::runtime::Handle::try_current().is_err());
        let mut cfg = HostConfig::new("nonexistent-host.invalid", "nobody");
        cfg.auto_connect = false;
        core.upsert_host(cfg);
        core.connect("nonexistent-host.invalid");
        core.notify_resumed();
        core.disconnect("nonexistent-host.invalid");
        core.remove_host("nonexistent-host.invalid");

        std::thread::sleep(Duration::from_millis(200));
        assert!(sink.0.lock().unwrap().iter().any(|e| matches!(e, CoreEvent::Config { .. })));
        drop(rt);
        let _ = std::fs::remove_dir_all(dir);
    }
}
