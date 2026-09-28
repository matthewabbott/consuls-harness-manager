//! End-to-end check of tmux on This PC (Cygwin on Windows), on a private tmux server:
//!
//!   cargo run -p chm-core --example localtmux
//!
//! Creates a tmux pane under `@local` in a given folder (Windows path in, Windows path out),
//! types into it through the control client, resizes it, fires the hook from inside it (routed
//! through the local events file to the tmux pane), closes it, and kills the private server.
//! Hook events go to a scratch state folder, never the real one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chm_core::harness::Harness;
use chm_core::link::Link;
use chm_core::local::{self, LOCAL_HOST};
use chm_core::model::{AttentionLevel, CoreEvent, FocusState, HostFacts, NewPaneSpec, PaneAttention, PaneInfo, PaneKind};
use chm_core::{Core, Sink};

#[derive(Default)]
struct Recorder {
    panes: Mutex<Vec<PaneInfo>>,
    facts: Mutex<Option<HostFacts>>,
    raw: Mutex<HashMap<u32, Vec<u8>>>,
    attention: Mutex<HashMap<u32, PaneAttention>>,
}

impl Sink for Recorder {
    fn event(&self, event: CoreEvent) {
        match event {
            CoreEvent::Panes { host, panes } if host == LOCAL_HOST => *self.panes.lock().unwrap() = panes,
            CoreEvent::Host { state } if state.id == LOCAL_HOST => *self.facts.lock().unwrap() = state.facts,
            CoreEvent::Attention { state } => {
                self.attention.lock().unwrap().insert(state.key, state);
            }
            CoreEvent::Notice { message, .. } => println!("  notice: {message}"),
            _ => {}
        }
    }
    fn frame(&self, frame: Vec<u8>) {
        let key = u32::from_le_bytes(frame[1..5].try_into().unwrap());
        match frame[0] {
            2 => self.raw.lock().unwrap().entry(key).or_default().extend_from_slice(&frame[9..]),
            3 => {
                self.raw.lock().unwrap().insert(key, frame[13..].to_vec());
            }
            _ => {}
        }
    }
}

async fn wait_for(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) -> anyhow::Result<()> {
    let start = Instant::now();
    while !check() {
        if start.elapsed() > timeout {
            anyhow::bail!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("ok   {what} ({:?})", start.elapsed());
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let Some(cygwin) = chm_core::cygwin::Cygwin::find() else {
        println!("no Cygwin with tmux here; nothing to check");
        return Ok(());
    };
    let socket = format!("chm-localtmux-{}", std::process::id());
    let dir = std::env::temp_dir().join(format!("chm-localtmux-{}", std::process::id()));
    let state = dir.join("state");
    std::fs::create_dir_all(&state)?;
    // SAFETY: set before any other thread reads the environment.
    unsafe {
        std::env::set_var("CHM_TMUX_SOCKET", &socket);
        std::env::set_var("XDG_STATE_HOME", &state);
    }
    let cleanup = Link::Local(cygwin.shell(&local::to_slash(&state)));

    let rec = Arc::new(Recorder::default());
    let core = Core::new(dir.join("data"), rec.clone());
    core.start();
    core.set_focus(FocusState { expanded: None, window_focused: false });
    wait_for("This PC reports tmux", Duration::from_secs(15), || rec.facts.lock().unwrap().as_ref().is_some_and(|f| f.tmux_version.is_some())).await?;
    println!("     tmux {} at {}", rec.facts.lock().unwrap().as_ref().unwrap().tmux_version.clone().unwrap(), cygwin.root.display());

    let folder = local::to_slash(&dir);
    let spec = NewPaneSpec { host: LOCAL_HOST.into(), cwd: folder.clone(), harness: Harness::Shell, name: None, session: None, args: None, direct: None, shell: None };
    let result = run(&core, &rec, spec, &folder).await;
    if result.is_err() {
        for p in rec.panes.lock().unwrap().iter() {
            println!("     pane {}: kind={:?} path={:?} cmd={:?}", p.key, p.kind, p.current_path, p.current_command);
        }
    }

    match cleanup.exec(&format!("tmux -L {socket} kill-server"), Duration::from_secs(15)).await {
        Ok(out) if out.success() => println!("     private tmux server stopped"),
        // Closing its only pane already ended it.
        Ok(out) if out.stderr_str().contains("no server running") => println!("     private tmux server already gone"),
        other => println!("     couldn't stop the private tmux server: {:?}", other.map(|o| (o.status, o.stderr_str()))),
    }
    let _ = std::fs::remove_dir_all(&dir);
    result?;
    println!("all local tmux checks passed");
    Ok(())
}

async fn run(core: &Arc<Core>, rec: &Arc<Recorder>, spec: NewPaneSpec, folder: &str) -> anyhow::Result<()> {
    let key = core.create_pane(spec).await.map_err(anyhow::Error::msg)?;
    let pane = |k: u32| rec.panes.lock().unwrap().iter().find(|p| p.key == k).cloned();
    let draw = |k: u32| String::from_utf8_lossy(rec.raw.lock().unwrap().get(&k).map(Vec::as_slice).unwrap_or(&[])).into_owned();
    wait_for("tmux pane listed under This PC", Duration::from_secs(15), || pane(key).is_some_and(|p| p.kind == PaneKind::Tmux)).await?;
    let same = |a: &str, b: &str| a.trim_end_matches('/').eq_ignore_ascii_case(b.trim_end_matches('/'));
    wait_for("its folder, as a Windows path", Duration::from_secs(10), || pane(key).is_some_and(|p| same(&p.current_path, folder))).await?;

    core.stream_pane(key, true);
    wait_for("RESET on expand", Duration::from_secs(10), || !draw(key).is_empty()).await?;
    core.send_text(key, "echo \"local-tmux-$((6*7))\"".into());
    core.send_keys(key, vec!["Enter".into()]);
    wait_for("typed into the pane (control client both ways)", Duration::from_secs(10), || draw(key).contains("local-tmux-42")).await?;

    core.resize_pane(key, 100, 30).await.map_err(anyhow::Error::msg)?;
    wait_for("resized to 100x30", Duration::from_secs(10), || pane(key).is_some_and(|p| (p.width, p.height) == (100, 30))).await?;

    // The hook, from inside the pane, as a harness would run it (Git's sh on Windows).
    let assets = local::ensure_assets().map_err(anyhow::Error::msg)?;
    core.send_text(key, format!("'{}' '{}' claude Stop </dev/null", assets.sh, assets.hook));
    core.send_keys(key, vec!["Enter".into()]);
    wait_for("hook reaches the tmux pane (TMUX_PANE, local events file)", Duration::from_secs(15), || {
        rec.attention.lock().unwrap().get(&key).is_some_and(|a| a.attention == AttentionLevel::Unacked)
    })
    .await?;

    let outcome = core.terminate_pane(key, true).await.map_err(anyhow::Error::msg)?;
    println!("     terminate: {outcome:?}");
    wait_for("pane removed", Duration::from_secs(10), || pane(key).is_none()).await?;
    Ok(())
}
