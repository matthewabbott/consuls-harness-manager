//! Types shared with the frontend (exported to TypeScript via ts-rs).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable identifier for a machine: the first label of its MagicDNS name (e.g. `spark2`),
/// or a user-chosen alias for machines that aren't on the tailnet.
pub type HostId = String;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TailnetPeer {
    /// Short name derived from the MagicDNS name; used as the [`HostId`].
    pub id: HostId,
    pub host_name: String,
    pub dns_name: String,
    pub os: String,
    pub ips: Vec<String>,
    pub online: bool,
    /// OpenSSH-format public host keys advertised by Tailscale (used for pinning).
    pub ssh_host_keys: Vec<String>,
    pub is_self: bool,
}

impl TailnetPeer {
    /// Tailscale only advertises SSH host keys for nodes running Tailscale SSH.
    pub fn has_tailscale_ssh(&self) -> bool {
        !self.ssh_host_keys.is_empty()
    }

    /// Prefer the IPv4 tailnet address; it survives MagicDNS hiccups after resume.
    pub fn preferred_ip(&self) -> Option<&str> {
        self.ips
            .iter()
            .find(|ip| !ip.contains(':'))
            .or_else(|| self.ips.first())
            .map(String::as_str)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TailnetStatus {
    /// Tailscale's BackendState: NoState, NeedsLogin, NeedsMachineAuth, Stopped, Starting, Running.
    pub backend_state: String,
    /// Login URL when Tailscale needs the user to authenticate.
    pub auth_url: Option<String>,
    pub self_node: Option<TailnetPeer>,
    pub peers: Vec<TailnetPeer>,
    pub tailnet_name: Option<String>,
    pub health: Vec<String>,
    /// Set when the Tailscale CLI couldn't be run or its output couldn't be parsed.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum AuthMode {
    /// Try `none` (Tailscale SSH), then the SSH agent, then default key files.
    #[default]
    Auto,
    /// Only use the SSH agent.
    Agent,
    /// Only use a specific private key file (unencrypted).
    KeyFile { path: String },
}

fn default_port() -> u16 {
    22
}

fn default_true() -> bool {
    true
}

/// Every field has a default so config files written by older versions keep loading (a
/// parse failure would otherwise reset the config and the next save would lose the hosts).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostConfig {
    pub id: HostId,
    /// Address to dial. When absent, the tailnet IP from `tailscale status` is used.
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub auth: AuthMode,
    /// Connect automatically on launch and keep reconnecting.
    #[serde(default = "default_true")]
    pub auto_connect: bool,
}

impl HostConfig {
    pub fn new(id: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            address: None,
            port: 22,
            user: user.into(),
            auth: AuthMode::Auto,
            auto_connect: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "phase")]
#[ts(export)]
pub enum HostPhase {
    Disconnected,
    Connecting,
    /// Tailscale SSH "check" mode: the user must open `url` to approve this connection.
    AwaitingTailscaleCheck { url: String },
    Connected,
    Reconnecting { attempt: u32, retry_in_ms: u32, last_error: String },
    /// A failure that retrying won't fix without user action (auth, host key).
    Failed { error: String, kind: HostErrorKind },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HostErrorKind {
    Auth,
    HostKeyMismatch,
    Network,
    TmuxMissing,
    Other,
}

/// Facts learned about a host after connecting.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostFacts {
    pub user: String,
    pub home: String,
    pub shell: String,
    pub uname: String,
    /// e.g. "3.4"; `None` if tmux isn't installed.
    pub tmux_version: Option<String>,
    /// Where tmux is, when the login shell's PATH doesn't have it.
    pub tmux_path: Option<String>,
}

/// Runtime state of a configured host.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostState {
    pub id: HostId,
    pub phase: HostPhase,
    pub facts: Option<HostFacts>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AppConfig {
    pub hosts: Vec<HostConfig>,
    pub sound: SoundPrefs,
    /// Label definitions; panes reference them by `id` (stored in tmux as `@chm_labels`).
    pub labels: Vec<LabelDef>,
    pub ui: UiPrefs,
}

/// UI preferences that must survive anything (a quit, a crash, a wiped WebView profile), so
/// the core keeps them in `config.json` instead of the webview's storage.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct UiPrefs {
    /// Machine id → the folder the Files explorer and the new-pane dialog start in.
    pub default_folders: std::collections::BTreeMap<String, String>,
    /// Recording mode: personal details are masked everywhere, toasts name nothing.
    pub recording: bool,
    /// …machine names too.
    pub hide_machine_names: bool,
}

/// A user-defined pane label ("tag"). The id is a slug fixed at creation, so renaming a label
/// never needs to rewrite options on (possibly offline) hosts.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LabelDef {
    pub id: String,
    pub name: String,
    /// CSS colour, e.g. `#f5a25d`.
    pub color: String,
}

/// Turns a label name into a stable id: lowercase ASCII letters/digits and dashes.
pub fn label_slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "label".into() } else { out.chars().take(32).collect() }
}

/// Notification sound preferences.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct SoundPrefs {
    /// Master switch for chimes.
    pub enabled: bool,
    /// 0.0 – 1.0.
    pub volume: f32,
    pub finished: bool,
    pub needs_input: bool,
    pub subtask: bool,
    pub bell: bool,
    /// Windows toasts when the app isn't focused.
    pub toasts: bool,
}

impl Default for SoundPrefs {
    fn default() -> Self {
        Self { enabled: true, volume: 0.7, finished: true, needs_input: true, subtask: true, bell: true, toasts: true }
    }
}

impl SoundPrefs {
    /// Whether a chime of this kind should play.
    pub fn allows(&self, kind: AlertKind) -> bool {
        self.enabled
            && match kind {
                AlertKind::Finished | AlertKind::Summary => self.finished,
                AlertKind::NeedsInput => self.needs_input,
                AlertKind::Subtask => self.subtask,
                AlertKind::Bell => self.bell,
            }
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    /// The exact shape v1 wrote to config.json must keep loading with every host intact.
    #[test]
    fn v1_config_still_loads() {
        let v1 = r#"{ "hosts": [
            { "id": "spark-d683", "address": null, "port": 22, "user": "consulear", "auth": { "kind": "auto" }, "autoConnect": true },
            { "id": "mbas-macbook-pro-1", "address": null, "port": 22, "user": "matthewabbott", "auth": { "kind": "auto" }, "autoConnect": true }
        ] }"#;
        let cfg: AppConfig = serde_json::from_str(v1).unwrap();
        assert_eq!(cfg.hosts.len(), 2);
        assert_eq!(cfg.hosts[1].user, "matthewabbott");
        assert_eq!(cfg.sound, SoundPrefs::default());
        assert_eq!(cfg.ui, UiPrefs::default());
    }

    #[test]
    fn ui_prefs_round_trip() {
        let mut cfg = AppConfig::default();
        cfg.ui.default_folders.insert("@local".into(), "D:/a/programming".into());
        cfg.ui.recording = true;
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains(r#""ui":{"defaultFolders":{"@local":"D:/a/programming"},"recording":true,"hideMachineNames":false}"#), "{json}");
        assert_eq!(serde_json::from_str::<AppConfig>(&json).unwrap(), cfg);
    }

    #[test]
    fn slugs() {
        assert_eq!(label_slug("Terrarium Project"), "terrarium-project");
        assert_eq!(label_slug("  urgent!! "), "urgent");
        assert_eq!(label_slug("☕"), "label");
    }

    #[test]
    fn sparse_and_empty_configs_load() {
        let cfg: AppConfig = serde_json::from_str(r#"{ "hosts": [ { "id": "x" } ], "futureField": 1 }"#).unwrap();
        assert_eq!((cfg.hosts[0].port, cfg.hosts[0].auto_connect), (22, true));
        let cfg: AppConfig = serde_json::from_str("{}").unwrap();
        assert!(cfg.hosts.is_empty());
    }
}

/// How a pane's process is hosted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PaneKind {
    /// A tmux pane: survives disconnects; tmux is the source of truth.
    Tmux,
    /// A plain shell on a PTY we own (SSH channel or local ConPTY). Lost when the connection
    /// or the app goes away, and never revived.
    Direct,
}

/// Where a tmux pane lives.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TmuxLoc {
    /// tmux ids, e.g. `%3`, `@2`, `$1`.
    pub pane_id: String,
    pub window_id: String,
    pub session_id: String,
    pub session_name: String,
    pub session_group: Option<String>,
    pub window_index: u32,
    pub window_name: String,
    pub pane_index: u32,
    pub dead: bool,
    pub window_active: bool,
    pub pane_active: bool,
    /// Panes in this pane's tmux window (resizing a split window affects its neighbours).
    pub window_panes: u32,
    /// Harness Manager has pinned this window's size.
    pub sized: bool,
}

/// One pane, as shown in the grid.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneInfo {
    /// App-wide numeric key; frames for this pane carry it.
    pub key: u32,
    pub host: HostId,
    pub kind: PaneKind,
    /// Set for [`PaneKind::Tmux`] panes.
    pub tmux: Option<TmuxLoc>,
    pub width: u16,
    pub height: u16,
    pub current_command: String,
    pub current_path: String,
    pub title: String,
    pub harness: Option<crate::harness::Harness>,
    pub alternate_on: bool,
    /// Stable identity: set on panes the app created (and on tmux panes the user has
    /// expanded), used to key per-pane preferences.
    pub chm_id: Option<String>,
    pub hidden: bool,
    /// Label ids (see [`LabelDef`]).
    pub labels: Vec<String>,
    /// Direct panes: why the session ended. The pane stays readable until dismissed.
    pub ended: Option<String>,
    /// The user's choice to ping (or not) when this pane rings the terminal bell.
    pub bell: Option<bool>,
    /// Whether a bell pings: the user's choice, else on for chat clients (irssi, weechat, …).
    pub bell_pings: bool,
}

/// Result of a resize request.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResizeOutcome {
    /// Regular (non-control) tmux clients also showing this pane's session, e.g. a phone.
    /// Their view of a pinned window is cropped or padded.
    pub other_clients: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// Request to create a new pane (and usually a new tmux session) running a harness.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewPaneSpec {
    pub host: HostId,
    /// Absolute working directory on the host.
    pub cwd: String,
    pub harness: crate::harness::Harness,
    /// Window (and default session) name; derived from the directory when absent.
    pub name: Option<String>,
    /// Add a window to this existing session instead of creating a new one.
    pub session: Option<String>,
    /// Extra command-line arguments for the harness.
    pub args: Option<String>,
    /// A plain shell on its own PTY instead of a tmux pane (lost on disconnect).
    #[serde(default)]
    #[ts(optional)]
    pub direct: Option<bool>,
    /// Local shells: which one (a [`LocalShell`] id). Remote direct shells use the login shell.
    #[serde(default)]
    #[ts(optional)]
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
#[ts(export)]
pub enum TerminateOutcome {
    /// The pane is gone.
    Closed,
    /// Something is still running (the harness didn't exit, or a shell has a foreground job).
    StillRunning { command: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DirEntryInfo {
    pub name: String,
    /// A directory (or a symlink to one).
    pub is_dir: bool,
    pub is_symlink: bool,
    #[ts(type = "number")]
    pub size: u64,
    /// Modification time, unix seconds.
    #[ts(type = "number")]
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DirListing {
    /// Canonical absolute path.
    pub path: String,
    pub home: String,
    pub entries: Vec<DirEntryInfo>,
}

/// Everything pushed to the UI (JSON). High-volume pane content goes through binary frames.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
#[ts(export)]
pub enum CoreEvent {
    Tailnet { status: TailnetStatus },
    Config { config: AppConfig },
    Host { state: HostState },
    HostRemoved { id: HostId },
    /// Full pane list for one host (sent whenever it changes).
    Panes { host: HostId, panes: Vec<PaneInfo> },
    Attention { state: PaneAttention },
    Notice { host: Option<HostId>, level: NoticeLevel, message: String },
    /// A program in pane `key` copied `text` to the clipboard (OSC 52); only sent while the
    /// app is focused.
    Clipboard { key: u32, text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CoreSnapshot {
    pub tailnet: TailnetStatus,
    pub config: AppConfig,
    pub hosts: Vec<HostState>,
    pub panes: Vec<PaneInfo>,
    pub attention: Vec<PaneAttention>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Activity {
    #[default]
    Unknown,
    Working,
    /// Finished its turn; waiting for the user.
    Idle,
    /// Blocked on the user: a permission prompt or a question.
    NeedsInput,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AttentionLevel {
    #[default]
    None,
    /// Something happened the user hasn't looked at yet (tile glows).
    Unacked,
    /// Seen, but still waiting on the user (tile shows a banner).
    Acked,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneAttention {
    pub key: u32,
    pub activity: Activity,
    pub attention: AttentionLevel,
    /// Short human description, e.g. "Finished", "Needs permission: Bash".
    pub reason: Option<String>,
    /// Unix seconds of the last state change.
    pub since: f64,
    /// Increments on transient events (a subagent finished) so the UI can pulse the tile.
    pub pulse: u32,
    /// "hook" (reported by the harness) or "heuristic" (guessed from output activity).
    pub source: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AlertKind {
    Finished,
    NeedsInput,
    Subtask,
    Summary,
    /// A program rang the terminal bell (e.g. an IRC highlight).
    Bell,
}

/// A notification the shell should surface (sound / toast / taskbar flash).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Alert {
    pub key: Option<u32>,
    pub kind: AlertKind,
    pub title: String,
    pub body: String,
    pub sound: bool,
    pub toast: bool,
    pub flash: bool,
}

/// What the user is looking at.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FocusState {
    pub expanded: Option<u32>,
    pub window_focused: bool,
}
