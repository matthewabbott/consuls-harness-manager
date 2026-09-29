//! End-to-end check of tmux on This PC (Cygwin on Windows, the native tmux on macOS/Linux), on a
//! private tmux server:
//!
//!   cargo run -p chm-core --example localtmux
//!
//! Creates a tmux pane under `@local` in a given folder (on Windows: Windows path in, Windows path
//! out), types into it through the control client, resizes it, fires the hook from inside it
//! (routed through the local events file to the tmux pane), closes it, and kills the private
//! server. Hook events go to a scratch state folder, never the real one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chm_core::harness::Harness;
use chm_core::link::Link;
use chm_core::local::{self, LOCAL_HOST};
use chm_core::model::{AttentionLevel, CoreEvent, FocusState, HostFacts, NewPaneSpec, NotifyMode, PaneAttention, PaneInfo, PaneKind};
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
    let cygwin = chm_core::cygwin::Cygwin::find();
    if cfg!(windows) && cygwin.is_none() {
        println!("no Cygwin with tmux here; nothing to check");
        return Ok(());
    }
    let socket = format!("chm-localtmux-{}", std::process::id());
    let dir = std::env::temp_dir().join(format!("chm-localtmux-{}", std::process::id()));
    let state = dir.join("state");
    std::fs::create_dir_all(&state)?;
    // SAFETY: set before any other thread reads the environment.
    unsafe {
        std::env::set_var("CHM_TMUX_SOCKET", &socket);
        std::env::set_var("XDG_STATE_HOME", &state);
    }

    let rec = Arc::new(Recorder::default());
    let core = Core::new(dir.join("data"), rec.clone());
    core.start();
    core.set_focus(FocusState { expanded: None, window_focused: false });
    // Elsewhere tmux is found through the login shell, if it's there at all.
    let found = wait_for("This PC reports tmux", Duration::from_secs(30), || rec.facts.lock().unwrap().as_ref().is_some_and(|f| f.tmux_version.is_some())).await;
    if found.is_err() && cygwin.is_none() {
        println!("no tmux here; nothing to check");
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(());
    }
    found?;
    let facts = rec.facts.lock().unwrap().clone().unwrap();
    let (tmux, cleanup) = match &cygwin {
        Some(c) => ("tmux".to_string(), Link::Local(c.shell(&local::to_slash(&state)))),
        None => (facts.tmux_path.clone().unwrap_or_else(|| "tmux".into()), posix_shell()),
    };
    let at = cygwin.as_ref().map_or_else(|| facts.tmux_path.clone().unwrap_or_else(|| "the login PATH".into()), |c| c.root.display().to_string());
    println!("     tmux {} at {at}", facts.tmux_version.clone().unwrap());

    // tmux reports a folder by its real path (macOS: /var/folders/… is /private/var/folders/…).
    let folder = if cfg!(windows) { local::to_slash(&dir) } else { local::to_slash(&dir.canonicalize()?) };
    let spec = NewPaneSpec { host: LOCAL_HOST.into(), cwd: folder.clone(), harness: Harness::Shell, name: None, session: None, args: None, direct: None, shell: None };
    let result = run(&core, &rec, spec, &folder, &cleanup, &format!("{tmux} -L {socket}")).await;
    if result.is_err() {
        for p in rec.panes.lock().unwrap().iter() {
            println!("     pane {}: kind={:?} path={:?} cmd={:?}", p.key, p.kind, p.current_path, p.current_command);
        }
    }

    match cleanup.exec(&format!("{tmux} -L {socket} kill-server"), Duration::from_secs(15)).await {
        Ok(out) if out.success() => println!("     private tmux server stopped"),
        // Closing its only pane already ended it.
        Ok(out) if out.stderr_str().contains("no server running") => println!("     private tmux server already gone"),
        other => println!("     couldn't stop the private tmux server: {:?}", other.map(|o| (o.status, o.stderr_str()))),
    }
    // A server that ends with its last session can leave its socket file behind.
    let _ = cleanup.exec(&format!("rm -f \"${{TMUX_TMPDIR:-/tmp}}/tmux-$(id -u)/{socket}\""), Duration::from_secs(15)).await;
    let _ = std::fs::remove_dir_all(&dir);
    result?;
    println!("all local tmux checks passed");
    Ok(())
}

#[cfg(unix)]
fn posix_shell() -> Link {
    Link::Local(chm_core::link::LocalSh::posix(Vec::new()))
}

#[cfg(not(unix))]
fn posix_shell() -> Link {
    unreachable!("Windows uses Cygwin's shell")
}

async fn run(core: &Arc<Core>, rec: &Arc<Recorder>, spec: NewPaneSpec, folder: &str, sh: &Link, tmux: &str) -> anyhow::Result<()> {
    let key = core.create_pane(spec).await.map_err(anyhow::Error::msg)?;
    let pane = |k: u32| rec.panes.lock().unwrap().iter().find(|p| p.key == k).cloned();
    let draw = |k: u32| String::from_utf8_lossy(rec.raw.lock().unwrap().get(&k).map(Vec::as_slice).unwrap_or(&[])).into_owned();
    wait_for("tmux pane listed under This PC", Duration::from_secs(15), || pane(key).is_some_and(|p| p.kind == PaneKind::Tmux)).await?;
    let same = |a: &str, b: &str| a.trim_end_matches('/').eq_ignore_ascii_case(b.trim_end_matches('/'));
    wait_for("its folder (Windows: as a Windows path)", Duration::from_secs(10), || pane(key).is_some_and(|p| same(&p.current_path, folder))).await?;

    core.stream_pane(key, true);
    wait_for("RESET on expand", Duration::from_secs(10), || !draw(key).is_empty()).await?;
    core.send_text(key, "echo \"local-tmux-$((6*7))\"".into());
    core.send_keys(key, vec!["Enter".into()]);
    wait_for("typed into the pane (control client both ways)", Duration::from_secs(10), || draw(key).contains("local-tmux-42")).await?;
    if cfg!(unix) {
        // A server we start has a UTF-8 locale, even when the app has none (started from the Dock).
        core.send_text(key, "printf 'loc=[%s]\\n' \"${LC_ALL:-${LC_CTYPE:-$LANG}}\"".into());
        core.send_keys(key, vec!["Enter".into()]);
        wait_for("the pane has a UTF-8 locale", Duration::from_secs(10), || {
            draw(key).split("loc=[").skip(1).any(|rest| rest.split(']').next().is_some_and(|l| l.contains("UTF-8")))
        })
        .await?;
    }

    core.resize_pane(key, 100, 30).await.map_err(anyhow::Error::msg)?;
    wait_for("resized to 100x30", Duration::from_secs(10), || pane(key).is_some_and(|p| (p.width, p.height) == (100, 30))).await?;

    // Names live in @chm_name; the tmux window keeps its own.
    let window = |k: u32| pane(k).and_then(|p| p.tmux).map(|t| t.window_name).unwrap_or_default();
    let original = window(key);
    core.rename_pane(key, Some("issue #9 · naïve".into()));
    wait_for("pane named", Duration::from_secs(10), || pane(key).is_some_and(|p| p.name.as_deref() == Some("issue #9 · naïve"))).await?;
    assert_eq!(window(key), original, "the tmux window keeps its name");
    core.rename_pane(key, None);
    wait_for("name cleared", Duration::from_secs(10), || pane(key).is_some_and(|p| p.name.is_none())).await?;

    // The hook, from inside the pane, as a harness would run it (Git's sh on Windows).
    let assets = local::ensure_assets().map_err(anyhow::Error::msg)?;
    core.send_text(key, format!("'{}' '{}' claude Stop </dev/null", assets.sh, assets.hook));
    core.send_keys(key, vec!["Enter".into()]);
    wait_for("hook reaches the tmux pane (TMUX_PANE, local events file)", Duration::from_secs(15), || {
        rec.attention.lock().unwrap().get(&key).is_some_and(|a| a.attention == AttentionLevel::Unacked)
    })
    .await?;

    // Push to phone: kept on the tmux pane, so every device and the daemon see it.
    let option = |name: &'static str| {
        let (sh, target) = (sh.clone(), format!("{tmux} show-options -pqv -t {} {name}", pane(key).and_then(|p| p.tmux).map(|t| t.pane_id).unwrap_or_default()));
        async move { sh.exec(&target, Duration::from_secs(10)).await.map(|o| o.stdout_str().trim().to_string()).unwrap_or_default() }
    };
    core.set_pane_notify(key, Some(NotifyMode::Delay));
    wait_for("tracked (@chm_notify)", Duration::from_secs(10), || pane(key).is_some_and(|p| p.notify == Some(NotifyMode::Delay))).await?;
    anyhow::ensure!(option("@chm_notify").await == "delay", "@chm_notify not set on the tmux pane");
    // It waits (the Stop above). Expanded in an unfocused window isn't "seen"...
    core.set_focus(FocusState { expanded: Some(key), window_focused: false });
    tokio::time::sleep(Duration::from_millis(800)).await;
    anyhow::ensure!(pane(key).is_some_and(|p| p.seen.is_none()), "an unfocused window marked the pane seen");
    // ...looking at it in a focused one is.
    core.set_focus(FocusState { expanded: Some(key), window_focused: true });
    wait_for("seen when looked at (@chm_seen)", Duration::from_secs(10), || pane(key).is_some_and(|p| p.seen.is_some())).await?;
    anyhow::ensure!(!option("@chm_seen").await.is_empty(), "@chm_seen not set on the tmux pane");
    core.set_focus(FocusState { expanded: None, window_focused: false });
    // Another device turns it off.
    let off = format!("{tmux} set-option -p -u -t {} @chm_notify", pane(key).and_then(|p| p.tmux).map(|t| t.pane_id).unwrap_or_default());
    sh.exec(&off, Duration::from_secs(10)).await?;
    wait_for("untracked by another client", Duration::from_secs(10), || pane(key).is_some_and(|p| p.notify.is_none())).await?;

    let outcome = core.terminate_pane(key, true).await.map_err(anyhow::Error::msg)?;
    println!("     terminate: {outcome:?}");
    wait_for("pane removed", Duration::from_secs(10), || pane(key).is_none()).await?;
    Ok(())
}
