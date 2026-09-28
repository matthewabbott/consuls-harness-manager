//! One actor per configured host: connects, keeps the connection alive, reconnects with
//! backoff, and runs the host's [`TmuxManager`] while connected.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info};

use super::ctx::Ctx;
use super::direct::{self, DirectSpec};
use super::tmux_mgr::{PaneCmd, TmuxManager};
use crate::fs::{FileContent, FileStamp, FsOp, SaveError};
use crate::fs::git::GitStatus;
use crate::fs::remote::{self as rfs, SftpPool};
use crate::model::{DirListing, HostConfig, HostErrorKind, HostFacts, HostPhase, NewPaneSpec, NoticeLevel};
use crate::ssh::exec::{self, ExecOutput};
use crate::ssh::{ConnectParams, SshConnection, SshError, SshNotice};
use crate::integration::events::{self, TailMsg};
use crate::integration::install::{self, IntegrationStatus};
use crate::model::{Alert, AlertKind};
use crate::tmux::TmuxServer;

pub(crate) enum HostCmd {
    Connect,
    Disconnect,
    Reconfigure(HostConfig),
    /// Verify the link (after resume / network change); reconnect if it's dead.
    Probe,
    /// The UI reloaded: re-send every tile and stop any raw streams.
    ResendTiles,
    /// Drop the connection and reconnect right away.
    Reconnect,
    Pane(PaneCmd),
    CreatePane { spec: NewPaneSpec, reply: oneshot::Sender<Result<u32, String>> },
    Integration { action: IntegrationAction, reply: oneshot::Sender<Result<IntegrationStatus, String>> },
    ListDir { path: String, reply: oneshot::Sender<Result<DirListing, String>> },
    Fs { op: FsOp, reply: oneshot::Sender<Result<(), String>> },
    FsCount { path: String, reply: oneshot::Sender<Result<u64, String>> },
    Git { dir: String, reply: oneshot::Sender<Result<Option<GitStatus>, String>> },
    ReadFile { path: String, reply: oneshot::Sender<Result<FileContent, String>> },
    GitHead { path: String, reply: oneshot::Sender<Result<crate::fs::git::HeadVersion, String>> },
    ReadBytes { path: String, reply: oneshot::Sender<Result<Vec<u8>, String>> },
    StatFile { path: String, reply: oneshot::Sender<Result<Option<FileStamp>, String>> },
    WriteFile { path: String, text: String, bom: bool, expect: Option<FileStamp>, reply: oneshot::Sender<Result<FileStamp, SaveError>> },
    Exec { script: String, reply: oneshot::Sender<Result<ExecOutput, String>> },
    Shutdown,
}

impl HostCmd {
    /// Answers a request that can't be served right now (not connected); drops the rest.
    fn refuse(self, why: &str) {
        let why = why.to_string();
        match self {
            HostCmd::CreatePane { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::Integration { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::ListDir { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::Fs { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::FsCount { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::Git { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::ReadFile { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::GitHead { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::ReadBytes { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::StatFile { reply, .. } => drop(reply.send(Err(why))),
            HostCmd::WriteFile { reply, .. } => drop(reply.send(Err(SaveError::Failed { message: why }))),
            HostCmd::Exec { reply, .. } => drop(reply.send(Err(why))),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum IntegrationAction {
    Status,
    Install,
    Uninstall,
}

pub(crate) struct HostHandle {
    pub tx: mpsc::UnboundedSender<HostCmd>,
}

impl HostHandle {
    pub fn send(&self, cmd: HostCmd) {
        let _ = self.tx.send(cmd);
    }
}

pub(crate) fn spawn(cfg: HostConfig, ctx: Arc<Ctx>, rt: &tokio::runtime::Handle) -> HostHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    rt.spawn(run(cfg, ctx, rx));
    HostHandle { tx }
}

enum ConnectResult {
    Connected(Arc<SshConnection>),
    Failed(SshError),
    Cancelled,
    Shutdown,
}

enum Outcome {
    UserDisconnect,
    Lost(String),
    Shutdown,
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        0 | 1 => 1,
        2 => 2,
        3 => 5,
        4 => 10,
        _ => 30,
    })
}

async fn run(mut cfg: HostConfig, ctx: Arc<Ctx>, mut rx: mpsc::UnboundedReceiver<HostCmd>) {
    let id = cfg.id.clone();
    let mut want = cfg.auto_connect;
    let mut attempt = 0u32;
    // Byte offset into the host's events.jsonl, kept across reconnects so missed events replay.
    let mut events_offset: Option<u64> = None;
    ctx.set_phase(&id, HostPhase::Disconnected);

    loop {
        if !want {
            if !matches!(ctx.host_states.lock().unwrap().get(&id).map(|s| &s.phase), Some(HostPhase::Failed { .. })) {
                ctx.set_phase(&id, HostPhase::Disconnected);
            }
            match rx.recv().await {
                None | Some(HostCmd::Shutdown) => return,
                Some(HostCmd::Connect | HostCmd::Reconnect) => {
                    want = true;
                    attempt = 0;
                }
                Some(HostCmd::Reconfigure(c)) => cfg = c,
                Some(other) => other.refuse("not connected"),
            }
            continue;
        }

        ctx.set_phase(&id, HostPhase::Connecting);
        let last_error = match connect_phase(&mut cfg, &ctx, &mut rx).await {
            ConnectResult::Connected(conn) => {
                attempt = 0;
                ctx.set_phase(&id, HostPhase::Connected);
                match connected_phase(conn, &mut cfg, &ctx, &mut rx, &mut events_offset).await {
                    Outcome::UserDisconnect => {
                        want = false;
                        continue;
                    }
                    Outcome::Shutdown => return,
                    Outcome::Lost(reason) => {
                        info!(host = %id, "connection lost: {reason}");
                        reason
                    }
                }
            }
            ConnectResult::Cancelled => {
                want = false;
                continue;
            }
            ConnectResult::Shutdown => return,
            ConnectResult::Failed(e) => {
                if e.is_fatal() {
                    let kind = match e {
                        SshError::HostKeyMismatch { .. } => HostErrorKind::HostKeyMismatch,
                        SshError::Auth(_) => HostErrorKind::Auth,
                        _ => HostErrorKind::Other,
                    };
                    ctx.set_phase(&id, HostPhase::Failed { error: e.to_string(), kind });
                    want = false;
                    continue;
                }
                e.to_string()
            }
        };

        attempt += 1;
        let delay = backoff(attempt);
        ctx.set_phase(
            &id,
            HostPhase::Reconnecting { attempt, retry_in_ms: delay.as_millis() as u32, last_error },
        );
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                cmd = rx.recv() => match cmd {
                    None | Some(HostCmd::Shutdown) => return,
                    Some(HostCmd::Connect | HostCmd::Probe | HostCmd::Reconnect) => break,
                    Some(HostCmd::Disconnect) => { want = false; break }
                    Some(HostCmd::Reconfigure(c)) => cfg = c,
                    Some(other) => other.refuse("not connected"),
                },
            }
        }
    }
}

fn resolve(cfg: &HostConfig, ctx: &Ctx) -> ConnectParams {
    let tailnet = ctx.tailnet.read().unwrap();
    let peer = tailnet.peers.iter().find(|p| p.id == cfg.id);
    let address = cfg
        .address
        .clone()
        .or_else(|| peer.and_then(|p| p.preferred_ip()).map(str::to_string))
        .unwrap_or_else(|| cfg.id.clone());
    // Only pin Tailscale's keys when we're actually dialing the tailnet address.
    let pinned_keys = match peer {
        Some(p) if cfg.address.is_none() || p.ips.contains(&address) => p.ssh_host_keys.clone(),
        _ => Vec::new(),
    };
    ConnectParams {
        host_id: cfg.id.clone(),
        address,
        port: cfg.port,
        user: cfg.user.clone(),
        auth: cfg.auth.clone(),
        pinned_keys,
    }
}

async fn connect_phase(
    cfg: &mut HostConfig,
    ctx: &Arc<Ctx>,
    rx: &mut mpsc::UnboundedReceiver<HostCmd>,
) -> ConnectResult {
    let params = resolve(cfg, ctx);
    let id = params.host_id.clone();
    let (ntx, mut nrx) = mpsc::unbounded_channel();
    let fut = SshConnection::connect(&params, ctx.known_hosts.clone(), ntx);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            res = &mut fut => return match res {
                Ok(conn) => ConnectResult::Connected(Arc::new(conn)),
                Err(e) => ConnectResult::Failed(e),
            },
            Some(notice) = nrx.recv() => match notice {
                SshNotice::TailscaleCheck { url } => ctx.set_phase(&id, HostPhase::AwaitingTailscaleCheck { url }),
                SshNotice::HostKeyTrusted { fingerprint } => ctx.notice(
                    Some(&id), NoticeLevel::Info, format!("Trusted {id}'s host key on first use ({fingerprint})"),
                ),
                SshNotice::Banner(b) => debug!(host = %id, "banner: {b}"),
            },
            cmd = rx.recv() => match cmd {
                None | Some(HostCmd::Shutdown) => return ConnectResult::Shutdown,
                Some(HostCmd::Disconnect) => return ConnectResult::Cancelled,
                Some(HostCmd::Reconfigure(c)) => *cfg = c,
                Some(other) => other.refuse("still connecting"),
            },
        }
    }
}

/// Host details, and where tmux is. Commands run in a login shell, which doesn't read
/// `~/.zshrc`/`~/.bashrc`; tmux installed somewhere only those add to PATH (a Homebrew in the
/// home folder, say) is looked for in the usual places, then asked of an interactive shell
/// (given 5 s, in case its startup files wait for something).
const FACTS_SCRIPT: &str = r#"t=$(command -v tmux 2>/dev/null); p=
case "$t" in /*) ;; *) t= ;; esac
if [ -z "$t" ]; then
  for c in "$HOME/.homebrew/bin/tmux" /opt/homebrew/bin/tmux /usr/local/bin/tmux /home/linuxbrew/.linuxbrew/bin/tmux \
      "$HOME/.linuxbrew/bin/tmux" "$HOME/.nix-profile/bin/tmux" /run/current-system/sw/bin/tmux /opt/local/bin/tmux \
      "$HOME/.local/bin/tmux" "$HOME/bin/tmux" /snap/bin/tmux; do
    if [ -x "$c" ]; then t=$c; p=$c; break; fi
  done
fi
if [ -z "$t" ] && f=$(mktemp 2>/dev/null); then
  ("$SHELL" -ic 'command -v tmux' </dev/null 2>/dev/null | tail -n 1 > "$f") & w=$!
  i=0; while kill -0 $w 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  kill $w 2>/dev/null
  c=$(cat "$f"); rm -f "$f"
  case "$c" in /*) [ -x "$c" ] && { t=$c; p=$c; } ;; esac
fi
printf 'user=%s
home=%s
shell=%s
uname=%s
tmux=%s
tmuxpath=%s
' "$(id -un)" "$HOME" "$SHELL" "$(uname -sr)" \
  "$([ -n "$t" ] && "$t" -V 2>/dev/null)" "$p""#;

fn parse_facts(out: &str) -> HostFacts {
    let mut facts = HostFacts::default();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k {
            "user" => facts.user = v.to_string(),
            "home" => facts.home = v.to_string(),
            "shell" => facts.shell = v.to_string(),
            "uname" => facts.uname = v.to_string(),
            "tmux" => facts.tmux_version = v.strip_prefix("tmux ").map(str::to_string).filter(|s| !s.is_empty()),
            "tmuxpath" => facts.tmux_path = Some(v.to_string()).filter(|p| p.starts_with('/')),
            _ => {}
        }
    }
    facts
}

async fn gather_facts(conn: &SshConnection) -> Result<HostFacts, String> {
    let out = exec::run(conn, FACTS_SCRIPT, Duration::from_secs(25)).await.map_err(|e| e.to_string())?;
    Ok(parse_facts(&out.stdout_str()))
}

/// tmux ≥ 3.2 is needed for `refresh-client -f/-A/-B` and `%extended-output`.
fn tmux_supported(version: &str) -> bool {
    let digits: String = version.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut parts = digits.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    (major, minor) >= (3, 2) || version.starts_with("next-") || version.starts_with("master")
}

async fn connected_phase(
    conn: Arc<SshConnection>,
    cfg: &mut HostConfig,
    ctx: &Arc<Ctx>,
    rx: &mut mpsc::UnboundedReceiver<HostCmd>,
    events_offset: &mut Option<u64>,
) -> Outcome {
    let id = cfg.id.clone();
    let facts = match gather_facts(&conn).await {
        Ok(f) => Some(f),
        Err(e) => {
            ctx.notice(Some(&id), NoticeLevel::Warning, format!("Couldn't read host details: {e}"));
            None
        }
    };
    ctx.set_facts(&id, facts.clone());
    let tmux_ok = match facts.as_ref().and_then(|f| f.tmux_version.as_deref()) {
        Some(v) if tmux_supported(v) => true,
        Some(v) => {
            ctx.notice(Some(&id), NoticeLevel::Error, format!("tmux {v} on {id} is too old; version 3.2 or newer is required"));
            false
        }
        None => {
            ctx.notice(Some(&id), NoticeLevel::Warning, format!("tmux isn't installed on {id}"));
            false
        }
    };

    // CHM_TMUX_SOCKET points everything at a private tmux server (`tmux -L …`); tests use it
    // so they never touch the user's real sessions.
    let server = TmuxServer {
        socket_name: std::env::var("CHM_TMUX_SOCKET").ok().filter(|s| !s.is_empty()),
        bin: facts.as_ref().and_then(|f| f.tmux_path.clone()),
    };
    let (mut mgr, mut events) = TmuxManager::new(id.clone(), conn.clone(), ctx.clone(), server);
    mgr.set_home(facts.as_ref().map(|f| f.home.clone()).filter(|h| !h.is_empty()));
    if tmux_ok {
        mgr.discover().await;
    }
    let mut tail = match events::start(&conn, *events_offset).await {
        Ok(rx) => Some(rx),
        Err(e) => {
            debug!(host = %id, "events tail unavailable: {e}");
            None
        }
    };
    let sftp = SftpPool::default();
    let replaying_since = std::time::Instant::now();
    let mut missed = 0usize;
    let mut last_missed_at: Option<std::time::Instant> = None;

    let mut tick = tokio::time::interval(Duration::from_millis(200));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                None | Some(HostCmd::Shutdown) => {
                    mgr.shutdown().await;
                    sftp.close().await;
                    conn.disconnect().await;
                    return Outcome::Shutdown;
                }
                Some(HostCmd::Disconnect) => {
                    mgr.shutdown().await;
                    conn.disconnect().await;
                    ctx.set_facts(&id, None);
                    return Outcome::UserDisconnect;
                }
                Some(HostCmd::Connect) => {}
                Some(HostCmd::Reconnect) => {
                    mgr.shutdown_quiet().await;
                    conn.disconnect().await;
                    return Outcome::Lost("reconnect requested".into());
                }
                Some(HostCmd::ResendTiles) => {
                    mgr.stop_streams();
                    mgr.resend_all();
                }
                Some(HostCmd::Pane(cmd)) => mgr.pane_cmd(cmd).await,
                Some(HostCmd::CreatePane { spec, reply }) if spec.direct == Some(true) => {
                    let res = create_direct(&conn, &mut mgr, ctx, spec, facts.as_ref()).await;
                    let _ = reply.send(res);
                }
                Some(HostCmd::CreatePane { spec, reply }) => {
                    let res = if tmux_ok { mgr.create_pane(spec).await } else { Err("tmux 3.2+ isn't available on this host".into()) };
                    let _ = reply.send(res);
                }
                Some(HostCmd::Integration { action, reply }) => {
                    let conn = conn.clone();
                    let home = facts.as_ref().map(|f| f.home.clone()).unwrap_or_default();
                    let tmux = facts.as_ref().and_then(|f| f.tmux_path.clone());
                    tokio::spawn(async move {
                        let res = if home.is_empty() {
                            Err("host details unknown".to_string())
                        } else {
                            match action {
                                IntegrationAction::Status => install::status(&conn, &home).await,
                                IntegrationAction::Install => install::install(&conn, &home, tmux.as_deref()).await,
                                IntegrationAction::Uninstall => install::uninstall(&conn, &home).await,
                            }
                        };
                        let _ = reply.send(res);
                    });
                }
                Some(HostCmd::ListDir { path, reply }) => {
                    let (conn, sftp) = (conn.clone(), sftp.clone());
                    let home = facts.as_ref().map(|f| f.home.clone()).unwrap_or_default();
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::list_dir(&conn, &sftp, &home, &path).await);
                    });
                }
                Some(HostCmd::Fs { op, reply }) => {
                    let (conn, sftp) = (conn.clone(), sftp.clone());
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::op(&conn, &sftp, op).await);
                    });
                }
                Some(HostCmd::FsCount { path, reply }) => {
                    let conn = conn.clone();
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::count(&conn, &path).await);
                    });
                }
                Some(HostCmd::ReadFile { path, reply }) => {
                    let (conn, sftp) = (conn.clone(), sftp.clone());
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::read(&conn, &sftp, &path).await);
                    });
                }
                Some(HostCmd::GitHead { path, reply }) => {
                    let conn = conn.clone();
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::git_head(&conn, &path).await);
                    });
                }
                Some(HostCmd::ReadBytes { path, reply }) => {
                    let (conn, sftp) = (conn.clone(), sftp.clone());
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::read_bytes(&conn, &sftp, &path).await);
                    });
                }
                Some(HostCmd::StatFile { path, reply }) => {
                    let (conn, sftp) = (conn.clone(), sftp.clone());
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::stat(&conn, &sftp, &path).await);
                    });
                }
                Some(HostCmd::WriteFile { path, text, bom, expect, reply }) => {
                    let (conn, sftp) = (conn.clone(), sftp.clone());
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::write(&conn, &sftp, &path, &text, bom, expect).await);
                    });
                }
                Some(HostCmd::Git { dir, reply }) => {
                    let conn = conn.clone();
                    tokio::spawn(async move {
                        let _ = reply.send(rfs::git_status(&conn, &dir).await);
                    });
                }
                Some(HostCmd::Probe) => {
                    if !mgr.probe().await {
                        conn.disconnect().await;
                        return Outcome::Lost("no response after resume".into());
                    }
                }
                Some(HostCmd::Reconfigure(c)) => {
                    let reconnect = c.address != cfg.address || c.user != cfg.user || c.port != cfg.port || c.auth != cfg.auth;
                    *cfg = c;
                    if reconnect {
                        mgr.shutdown().await;
                        conn.disconnect().await;
                        return Outcome::Lost("configuration changed".into());
                    }
                }
                Some(HostCmd::Exec { script, reply }) => {
                    let conn = conn.clone();
                    tokio::spawn(async move {
                        let res = exec::run(&conn, &script, Duration::from_secs(60)).await.map_err(|e| e.to_string());
                        let _ = reply.send(res);
                    });
                }
            },
            Some((key, ev)) = events.recv() => mgr.on_event(key, ev).await,
            Some(msg) = async { match tail.as_mut() { Some(t) => t.recv().await, None => std::future::pending().await } } => match msg {
                TailMsg::Started { offset } => *events_offset = Some(offset),
                TailMsg::Event { event, end_offset } => {
                    *events_offset = Some(end_offset);
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    // Events replayed right after (re)connecting that are clearly old: fold
                    // them into one summary instead of a burst of pings.
                    let stale = replaying_since.elapsed() < Duration::from_secs(3) && event.ts + 20 < now;
                    let alerted = direct::route_hook(ctx, &event, stale) || mgr.on_hook(&event, stale);
                    if stale && !alerted && matches!(event.event.as_str(), "Stop" | "PermissionRequest" | "AskUserQuestion") {
                        missed += 1;
                        last_missed_at = Some(std::time::Instant::now());
                    }
                }
                TailMsg::Closed => tail = None,
            },
            _ = tick.tick() => {
                if tmux_ok { mgr.tick().await }
                if missed > 0 && last_missed_at.is_some_and(|t| t.elapsed() > Duration::from_secs(1)) {
                    let unfocused = !ctx.attention.lock().unwrap().focus.window_focused;
                    ctx.sink.alert(Alert {
                        key: None,
                        kind: AlertKind::Summary,
                        title: format!("{missed} agent{} on {id} need{} you", if missed == 1 { "" } else { "s" }, if missed == 1 { "s" } else { "" }),
                        body: "They finished or asked for input while you were away.".into(),
                        sound: true,
                        toast: unfocused,
                        flash: unfocused,
                    });
                    missed = 0;
                }
            },
            _ = conn.closed() => return Outcome::Lost("connection closed".into()),
        }
    }
}

/// Initial size of a direct shell until the UI fits it.
pub(crate) const DIRECT_COLS: u16 = 120;
pub(crate) const DIRECT_ROWS: u16 = 34;

/// Starts a plain login shell on its own PTY channel (no tmux), in `spec.cwd`, with
/// `CHM_PANE` set so hooks fired inside it find their way back to the pane.
async fn create_direct(
    conn: &SshConnection,
    mgr: &mut TmuxManager,
    ctx: &Arc<Ctx>,
    spec: NewPaneSpec,
    facts: Option<&HostFacts>,
) -> Result<u32, String> {
    let chm_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    // Deployed even for a plain shell: hooks of agents started in it by hand use the script.
    let assets = mgr.ensure_assets().await;
    let launch = spec.harness.launch_command(assets.as_ref(), spec.args.as_deref().unwrap_or(""));
    // Run through sh so the user's own shell (bash, zsh, fish, …) only has to parse a plain
    // command line; then exec their login shell interactively.
    let script = r#"cd "$1" 2>/dev/null; CHM_PANE="$2"; COLORTERM=truecolor; export CHM_PANE COLORTERM; exec "${SHELL:-/bin/sh}" -l"#;
    let command = format!("exec sh -c {} chm {} {}", exec::sh_quote(script), exec::sh_quote(&spec.cwd), exec::sh_quote(&format!("direct:{chm_id}")));
    let pty = crate::pty::ssh(conn, &command, DIRECT_COLS, DIRECT_ROWS).await.map_err(|e| e.to_string())?;
    let shell = facts.map(|f| f.shell.rsplit('/').next().unwrap_or("shell").to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "shell".into());
    if let Some(cmd) = &launch {
        // Typed like a user would; the tty buffers it until the shell is ready.
        let _ = pty.input.send(crate::pty::PtyInput::Data(format!("{cmd}\r").into_bytes()));
    }
    let spec = DirectSpec {
        host: spec.host,
        cwd: spec.cwd,
        command: shell,
        harness: (spec.harness != crate::harness::Harness::Shell).then_some(spec.harness),
        chm_id,
        cols: DIRECT_COLS,
        rows: DIRECT_ROWS,
    };
    Ok(direct::spawn(ctx, &tokio::runtime::Handle::current(), spec, pty))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facts_parse_tmux_outside_path() {
        let f = parse_facts("user=m\nhome=/Users/m\nshell=/bin/zsh\nuname=Darwin 25\ntmux=tmux 3.7c\ntmuxpath=/Users/m/.homebrew/bin/tmux\n");
        assert_eq!(f.tmux_version.as_deref(), Some("3.7c"));
        assert_eq!(f.tmux_path.as_deref(), Some("/Users/m/.homebrew/bin/tmux"));
        let f = parse_facts("user=m\ntmux=\ntmuxpath=\n");
        assert_eq!((f.tmux_version, f.tmux_path), (None, None));
    }

    #[test]
    fn version_gate() {
        assert!(tmux_supported("3.4"));
        assert!(tmux_supported("3.2a"));
        assert!(tmux_supported("3.8-rc2"));
        assert!(tmux_supported("next-3.9"));
        assert!(!tmux_supported("3.1c"));
        assert!(!tmux_supported("2.9"));
    }

    #[test]
    fn backoff_caps() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(9), Duration::from_secs(30));
    }
}
