//! End-to-end check of the whole core against a real host, using a private tmux server so
//! the user's sessions are never touched:
//!
//!   cargo run -p chm-core --example selftest -- <host> <user> [harness] [cwd]
//!
//! Creates a throwaway session, then drives it through `Core` exactly like the UI does:
//! discovery → tile frames → expand (RESET) → typing/keys/paste (RAW) → create a pane
//! running `harness` (default: shell) → hide/unhide → graceful terminate → cleanup.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chm_core::harness::Harness;
use chm_core::model::{Activity, Alert, AttentionLevel, CoreEvent, FocusState, HostConfig, NewPaneSpec, PaneAttention, PaneInfo, TerminateOutcome};
use chm_core::{Core, Sink};

#[derive(Default)]
struct Recorder {
    panes: Mutex<Vec<PaneInfo>>,
    raw: Mutex<HashMap<u32, Vec<u8>>>,
    resets: Mutex<HashMap<u32, usize>>,
    tiles: Mutex<HashMap<u32, usize>>,
    attention: Mutex<HashMap<u32, PaneAttention>>,
    alerts: Mutex<Vec<Alert>>,
}

impl Sink for Recorder {
    fn event(&self, event: CoreEvent) {
        match event {
            CoreEvent::Panes { panes, .. } => *self.panes.lock().unwrap() = panes,
            CoreEvent::Notice { level, message, .. } => println!("  notice [{level:?}] {message}"),
            CoreEvent::Attention { state } => {
                self.attention.lock().unwrap().insert(state.key, state);
            }
            _ => {}
        }
    }
    fn alert(&self, alert: Alert) {
        println!("  alert: {} — {} (sound={} toast={})", alert.title, alert.body, alert.sound, alert.toast);
        self.alerts.lock().unwrap().push(alert);
    }
    fn frame(&self, frame: Vec<u8>) {
        let key = u32::from_le_bytes(frame[1..5].try_into().unwrap());
        match frame[0] {
            1 => *self.tiles.lock().unwrap().entry(key).or_default() += 1,
            2 => self.raw.lock().unwrap().entry(key).or_default().extend_from_slice(&frame[9..]),
            3 => {
                *self.resets.lock().unwrap().entry(key).or_default() += 1;
                self.raw.lock().unwrap().insert(key, Vec::new());
            }
            _ => {}
        }
    }
}

async fn wait_for(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        if start.elapsed() > timeout {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("ok   {what} ({:?})", start.elapsed());
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (host, user) = (args.first().expect("host").clone(), args.get(1).expect("user").clone());
    let socket = format!("chm-selftest-{}", std::process::id());
    // SAFETY: set before any other thread reads the environment.
    unsafe { std::env::set_var("CHM_TMUX_SOCKET", &socket) };

    let dir = std::env::temp_dir().join(format!("chm-selftest-{}", std::process::id()));
    let rec = Arc::new(Recorder::default());
    let core = Core::new(dir.clone(), rec.clone());
    core.start();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    core.upsert_host(HostConfig::new(&host, &user));

    // Wait for the connection, then create the scratch session on the private server.
    let mut created = false;
    for _ in 0..50 {
        if let Ok(out) = core
            .exec(&host, &format!("tmux -L {socket} new-session -d -s scratch -x 90 -y 20 'bash --norc --noprofile'"))
            .await
        {
            assert!(out.success(), "new-session failed: {}", out.stderr_str());
            created = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(created, "never connected");
    println!("ok   scratch session created on -L {socket}");

    wait_for("pane discovered", Duration::from_secs(20), || !rec.panes.lock().unwrap().is_empty()).await;
    let key = rec.panes.lock().unwrap()[0].key;
    wait_for("tile frame", Duration::from_secs(5), || rec.tiles.lock().unwrap().contains_key(&key)).await;

    core.stream_pane(key, true);
    wait_for("RESET frame on expand", Duration::from_secs(5), || rec.resets.lock().unwrap().contains_key(&key)).await;

    core.send_text(key, "echo \"typed-$((6*7))\" 'quotes' ~ $HOME".into());
    core.send_keys(key, vec!["Enter".into()]);
    let raw_has = |needle: &str| String::from_utf8_lossy(rec.raw.lock().unwrap().get(&key).map(Vec::as_slice).unwrap_or(&[])).contains(needle);
    wait_for("typed command echoed and executed", Duration::from_secs(5), || raw_has("typed-42")).await;

    core.paste_text(key, "printf '%s\\n' pasted-one\n".into());
    wait_for("paste executed", Duration::from_secs(5), || raw_has("pasted-one")).await;

    core.send_keys(key, vec!["C-c".into()]);

    // Drop the connection: it must come back on its own, with the same pane keys, and the
    // expanded pane must get a fresh RESET without the UI asking again.
    let resets_before = rec.resets.lock().unwrap().get(&key).copied().unwrap_or(0);
    let started = Instant::now();
    core.reconnect(&host);
    wait_for("reconnected with a fresh RESET for the expanded pane", Duration::from_secs(20), || {
        rec.resets.lock().unwrap().get(&key).copied().unwrap_or(0) > resets_before
    })
    .await;
    println!("     (reconnect round trip {:?})", started.elapsed());
    assert!(rec.panes.lock().unwrap().iter().any(|p| p.key == key), "pane key stable across reconnect");
    core.stream_pane(key, false);

    // --- lifecycle: list dir, create, hide, terminate
    let listing = core.list_dir(&host, "~").await.map_err(anyhow::Error::msg)?;
    println!("ok   list_dir ~ -> {} ({} entries)", listing.path, listing.entries.len());
    let harness = args.get(2).and_then(|h| Harness::from_name(h)).unwrap_or(Harness::Shell);
    let cwd = args.get(3).cloned().unwrap_or_else(|| listing.path.clone());
    let spec = NewPaneSpec { host: host.clone(), cwd: cwd.clone(), harness, name: None, session: None, args: None };
    let new_key = core.create_pane(spec).await.map_err(anyhow::Error::msg)?;
    println!("ok   create_pane {} in {cwd} -> key {new_key}", harness.name());
    let find = |k: u32| rec.panes.lock().unwrap().iter().find(|p| p.key == k).cloned();
    wait_for("new pane listed with @chm_harness", Duration::from_secs(10), || {
        find(new_key).is_some_and(|p| p.chm_id.is_some())
    })
    .await;
    if harness != Harness::Shell {
        wait_for(&format!("{} running in the new pane", harness.name()), Duration::from_secs(30), || {
            find(new_key).is_some_and(|p| Harness::from_name(&p.current_command) == Some(harness))
        })
        .await;
        tokio::time::sleep(Duration::from_secs(3)).await; // let the TUI settle
    }
    // Fire the real hook script from inside the pane (tmux sets $TMUX_PANE there) and check
    // the event travels events.jsonl -> tail -> attention -> alert.
    if harness == Harness::Shell {
        core.set_focus(FocusState { expanded: None, window_focused: false });
        core.send_text(new_key, "sh ~/.local/share/consuls/chm-hook.sh claude Stop </dev/null; clear".into());
        core.send_keys(new_key, vec!["Enter".into()]);
        wait_for("Stop hook -> attention Unacked", Duration::from_secs(10), || {
            rec.attention.lock().unwrap().get(&new_key).is_some_and(|a| a.activity == Activity::Idle && a.attention == AttentionLevel::Unacked)
        })
        .await;
        let alert = rec.alerts.lock().unwrap().last().cloned().expect("alert");
        assert!(alert.sound && alert.toast, "unfocused app should get sound + toast");
        core.ack_pane(new_key);
        wait_for("ack -> Acked", Duration::from_secs(5), || {
            rec.attention.lock().unwrap().get(&new_key).is_some_and(|a| a.attention == AttentionLevel::Acked)
        })
        .await;
    }
    core.set_pane_hidden(new_key, true);
    wait_for("pane hidden", Duration::from_secs(5), || find(new_key).is_some_and(|p| p.hidden)).await;
    core.set_pane_hidden(new_key, false);
    wait_for("pane unhidden", Duration::from_secs(5), || find(new_key).is_some_and(|p| !p.hidden)).await;
    let started = Instant::now();
    let outcome = core.terminate_pane(new_key, false).await.map_err(anyhow::Error::msg)?;
    println!("ok   terminate -> {outcome:?} in {:?}", started.elapsed());
    assert_eq!(outcome, TerminateOutcome::Closed, "graceful terminate didn't close the pane");
    wait_for("pane removed", Duration::from_secs(10), || find(new_key).is_none()).await;
    println!("all checks passed");

    let _ = core.exec(&host, &format!("tmux -L {socket} kill-server")).await;
    core.disconnect(&host);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}
