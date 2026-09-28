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

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostConfig {
    pub id: HostId,
    /// Address to dial. When absent, the tailnet IP from `tailscale status` is used.
    pub address: Option<String>,
    pub port: u16,
    pub user: String,
    pub auth: AuthMode,
    /// Connect automatically on launch and keep reconnecting.
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppConfig {
    pub hosts: Vec<HostConfig>,
}

/// One tmux pane, as shown in the grid.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneInfo {
    /// App-wide numeric key; frames for this pane carry it.
    pub key: u32,
    pub host: HostId,
    /// tmux ids, e.g. `%3`, `@2`, `$1`.
    pub pane_id: String,
    pub window_id: String,
    pub session_id: String,
    pub session_name: String,
    pub session_group: Option<String>,
    pub window_index: u32,
    pub window_name: String,
    pub pane_index: u32,
    pub width: u16,
    pub height: u16,
    pub current_command: String,
    pub current_path: String,
    pub title: String,
    pub harness: Option<crate::harness::Harness>,
    pub dead: bool,
    pub alternate_on: bool,
    pub window_active: bool,
    pub pane_active: bool,
    /// Set on panes the app created.
    pub chm_id: Option<String>,
    pub hidden: bool,
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
    pub is_dir: bool,
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
