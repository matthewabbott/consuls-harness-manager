//! tmux on This PC: the same tmux manager as remote hosts, over a local shell instead of SSH
//! (Cygwin's on Windows, see `cygwin`). Its panes join This PC's plain shells under `@local`.
//! The tmux server outlives the app, like on any host; this only watches and drives it.

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

pub(crate) fn spawn(ctx: Arc<Ctx>, rt: &tokio::runtime::Handle, cygwin: Cygwin) -> LocalTmux {
    let (tx, rx) = mpsc::unbounded_channel();
    rt.spawn(run(ctx, cygwin, rx));
    LocalTmux { tx }
}

async fn run(ctx: Arc<Ctx>, cygwin: Cygwin, mut rx: mpsc::UnboundedReceiver<LocalTmuxCmd>) {
    let state_dir = local::to_slash(&local::state_dir());
    let link = Link::Local(cygwin.shell(&state_dir));
    let map = match link.exec("mount", Duration::from_secs(20)).await {
        Ok(out) if out.success() => PathMap::parse(&out.stdout_str()),
        other => {
            debug!("cygwin mount table unavailable: {:?}", other.map(|o| o.stderr_str()));
            PathMap::default()
        }
    };
    // CHM_TMUX_SOCKET points everything at a private tmux server (tests).
    let server = TmuxServer { socket_name: std::env::var("CHM_TMUX_SOCKET").ok().filter(|s| !s.is_empty()), bin: None };
    let prefix = server.prefix();
    let (mut mgr, mut events) = TmuxManager::new(LOCAL_HOST.into(), link.clone(), ctx.clone(), server);
    mgr.set_home(Some(local::home()));
    mgr.set_path_map(map);
    // Our panes start where asked (Cygwin's profile would `cd ~`) and report hook events to the
    // file this app watches.
    mgr.set_pane_env(vec![("CHERE_INVOKING".into(), "1".into()), ("CHM_STATE_DIR".into(), state_dir.clone())]);
    info!("tmux on this PC through Cygwin at {}", cygwin.root.display());

    // Panes started by hand (in mintty) should report too: tell a running server where events go.
    let announce = |link: Link, prefix: String, state_dir: String| async move {
        let script = format!("{prefix} set-environment -g CHM_STATE_DIR {} 2>/dev/null; true", sh_quote(&state_dir));
        let _ = link.exec(&script, Duration::from_secs(15)).await;
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

/// tmux on this machine, if there is one to use.
pub(crate) fn find() -> Option<Cygwin> {
    if cfg!(windows) { Cygwin::find() } else { None }
}
