//! tmux on This PC: the same tmux manager as remote hosts, over a local shell instead of SSH —
//! Cygwin's on Windows (see `cygwin`), `/bin/sh` and the user's login shell elsewhere. Its panes
//! join This PC's plain shells under `@local`. The tmux server outlives the app, like on any
//! host; this only watches and drives it.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info};

use super::ctx::Ctx;
use super::tmux_mgr::{PaneCmd, TmuxManager};
use crate::cygwin::{Cygwin, PathMap};
use crate::integration::events::HookEvent;
use crate::link::Link;
use crate::local::{self, LOCAL_HOST};
use crate::model::NewPaneSpec;
use crate::ssh::exec::sh_quote;
use crate::tmux::TmuxServer;

pub(crate) enum LocalTmuxCmd {
    Pane(PaneCmd),
    CreatePane { spec: NewPaneSpec, reply: oneshot::Sender<Result<u32, String>> },
    Hook(HookEvent),
    ResendTiles,
    Probe,
}

#[derive(Clone)]
pub(crate) struct LocalTmux {
    tx: mpsc::UnboundedSender<LocalTmuxCmd>,
}

impl LocalTmux {
    pub fn send(&self, cmd: LocalTmuxCmd) -> bool {
        self.tx.send(cmd).is_ok()
    }
}

/// Which tmux this machine has.
pub(crate) enum Flavor {
    /// Cygwin's (Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    Cygwin(Cygwin),
    /// A native one (macOS, Linux).
    #[cfg_attr(windows, allow(dead_code))]
    Native(Native),
}

/// A native tmux, as the hosts' facts script finds it from the login shell.
#[derive(Debug, Clone)]
#[cfg_attr(windows, allow(dead_code))]
pub(crate) struct Native {
    pub version: String,
    /// Its absolute path when the login shell's PATH doesn't have it (`HostFacts::tmux_path`).
    pub bin: Option<String>,
    /// What hooks call (`__TMUX__`): found the way `assets::ensure` finds it over SSH.
    pub hook_tmux: String,
}

pub(crate) fn spawn(ctx: Arc<Ctx>, rt: &tokio::runtime::Handle, flavor: Flavor) -> LocalTmux {
    let (tx, rx) = mpsc::unbounded_channel();
    rt.spawn(run(ctx, flavor, rx));
    LocalTmux { tx }
}

async fn run(ctx: Arc<Ctx>, flavor: Flavor, mut rx: mpsc::UnboundedReceiver<LocalTmuxCmd>) {
    let state_dir = local::to_slash(&local::state_dir());
    // CHM_TMUX_SOCKET points everything at a private tmux server (tests).
    let socket_name = std::env::var("CHM_TMUX_SOCKET").ok().filter(|s| !s.is_empty());
    let cygwin = matches!(flavor, Flavor::Cygwin(_));
    let (link, server, map, pane_env) = match flavor {
        Flavor::Cygwin(cygwin) => {
            let link = Link::Local(cygwin.shell(&state_dir));
            let map = match link.exec("mount", Duration::from_secs(20)).await {
                Ok(out) if out.success() => PathMap::parse(&out.stdout_str()),
                other => {
                    debug!("cygwin mount table unavailable: {:?}", other.map(|o| o.stderr_str()));
                    PathMap::default()
                }
            };
            info!("tmux on this PC through Cygwin at {}", cygwin.root.display());
            // Our panes start where asked (Cygwin's profile would `cd ~`) and report hook events
            // to the file this app watches.
            let env = vec![("CHERE_INVOKING".into(), "1".into()), ("CHM_STATE_DIR".into(), state_dir.clone())];
            (link, TmuxServer { socket_name, bin: None }, Some(map), env)
        }
        Flavor::Native(native) => {
            let link = native_link(&state_dir);
            info!("tmux {} on this PC ({})", native.version, native.bin.as_deref().unwrap_or("on the login PATH"));
            let env = vec![("CHM_STATE_DIR".into(), state_dir.clone())];
            (link, TmuxServer { socket_name, bin: native.bin }, None, env)
        }
    };
    let prefix = server.prefix();
    let (mut mgr, mut events) = TmuxManager::new(LOCAL_HOST.into(), link.clone(), ctx.clone(), server);
    mgr.set_home(Some(local::home()));
    if let Some(map) = map {
        mgr.set_path_map(map);
    }
    mgr.set_pane_env(pane_env);

    // Panes started by hand (in mintty) should report too: tell a running server where events
    // go. A native server needs no telling: hooks there already default to this app's events
    // file (`~/.local/state/consuls`), and the user's server is left as it is.
    let announce = |link: Link, prefix: String, state_dir: String| async move {
        if cygwin {
            let script = format!("{prefix} set-environment -g CHM_STATE_DIR {} 2>/dev/null; true", sh_quote(&state_dir));
            let _ = link.exec(&script, Duration::from_secs(15)).await;
        }
    };
    mgr.discover().await;
    announce(link.clone(), prefix.clone(), state_dir.clone()).await;

    let mut tick = tokio::time::interval(Duration::from_millis(200));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                None => {
                    mgr.shutdown().await;
                    return;
                }
                Some(LocalTmuxCmd::Pane(cmd)) => mgr.pane_cmd(cmd).await,
                Some(LocalTmuxCmd::CreatePane { spec, reply }) => {
                    let res = mgr.create_pane(spec).await;
                    let _ = reply.send(res);
                    announce(link.clone(), prefix.clone(), state_dir.clone()).await;
                }
                Some(LocalTmuxCmd::Hook(event)) => {
                    mgr.on_hook(&event, false);
                }
                Some(LocalTmuxCmd::ResendTiles) => {
                    mgr.stop_streams();
                    mgr.resend_all();
                }
                Some(LocalTmuxCmd::Probe) => {
                    mgr.probe().await;
                }
            },
            Some((key, ev)) = events.recv() => mgr.on_event(key, ev).await,
            _ = tick.tick() => mgr.tick().await,
        }
    }
}

/// The shell a native tmux is driven through: `/bin/sh` running the login shell, as over SSH.
/// A tmux server it starts hands `CHM_STATE_DIR` to hand-made panes too.
#[cfg(unix)]
fn native_link(state_dir: &str) -> Link {
    Link::Local(crate::link::LocalSh::posix(vec![("CHM_STATE_DIR".into(), state_dir.into())]))
}

#[cfg(not(unix))]
fn native_link(_state_dir: &str) -> Link {
    unreachable!("native tmux is only looked for on unix")
}

/// Cygwin's tmux (Windows), if installed.
pub(crate) fn find_cygwin() -> Option<Cygwin> {
    if cfg!(windows) { Cygwin::find() } else { None }
}

/// A native tmux (macOS, Linux): the hosts' facts script, run in the login shell, finds it on
/// PATH, in the usual places, or through an interactive shell (a Homebrew only `~/.zshrc` adds).
#[cfg(unix)]
pub(crate) async fn find_native() -> Option<Native> {
    let link = native_link(&local::to_slash(&local::state_dir()));
    let out = match link.exec(super::host::FACTS_SCRIPT, Duration::from_secs(25)).await {
        Ok(out) if out.success() => out,
        other => {
            info!("no tmux on this PC: facts script failed: {:?}", other.map(|o| o.stderr_str()));
            return None;
        }
    };
    let facts = super::host::parse_facts(&out.stdout_str());
    let Some(version) = facts.tmux_version else {
        info!("no tmux on this PC");
        return None;
    };
    let hook_tmux = match &facts.tmux_path {
        Some(p) => p.clone(),
        None => link
            .exec("command -v tmux", Duration::from_secs(15))
            .await
            .map(|o| o.stdout_str().trim().to_string())
            .ok()
            .filter(|p| p.starts_with('/'))
            .unwrap_or_else(|| "tmux".into()),
    };
    Some(Native { version, bin: facts.tmux_path, hook_tmux })
}
