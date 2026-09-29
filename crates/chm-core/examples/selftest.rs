//! End-to-end check of the whole core against a real host, using a private tmux server so
//! the user's sessions are never touched:
//!
//!   cargo run -p chm-core --example selftest -- <host> <user> [harness] [cwd]
//!
//! Creates a throwaway session, then drives it through `Core` exactly like the UI does:
//! discovery → tile frames → expand (RESET) → typing/keys/paste (RAW) → sizing → labels →
//! a direct (no tmux) shell → reconnect → create a pane running `harness` (default: shell)
//! → hide/unhide → graceful terminate → cleanup.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chm_core::fs::{FileContent, FsOp, SaveError};
use chm_core::fs::git::GitFileStatus;
use chm_core::harness::Harness;
use chm_core::model::{Activity, Alert, AlertKind, AttentionLevel, CoreEvent, FocusState, HostConfig, NewPaneSpec, PaneAttention, PaneInfo, PaneKind, TerminateOutcome};
use chm_core::{Core, Sink};

#[derive(Default)]
struct Recorder {
    panes: Mutex<Vec<PaneInfo>>,
    facts: Mutex<Option<chm_core::model::HostFacts>>,
    raw: Mutex<HashMap<u32, Vec<u8>>>,
    resets: Mutex<HashMap<u32, usize>>,
    tiles: Mutex<HashMap<u32, usize>>,
    attention: Mutex<HashMap<u32, PaneAttention>>,
    alerts: Mutex<Vec<Alert>>,
    clipboard: Mutex<Vec<(u32, String)>>,
}

impl Sink for Recorder {
    fn event(&self, event: CoreEvent) {
        match event {
            CoreEvent::Panes { panes, .. } => *self.panes.lock().unwrap() = panes,
            CoreEvent::Host { state } if state.id != "@local" => *self.facts.lock().unwrap() = state.facts,
            CoreEvent::Notice { level, message, .. } => println!("  notice [{level:?}] {message}"),
            CoreEvent::Attention { state } => {
                self.attention.lock().unwrap().insert(state.key, state);
            }
            CoreEvent::Clipboard { key, text } => self.clipboard.lock().unwrap().push((key, text)),
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
                // The rebuilt terminal starts from the RESET payload (after cols, rows).
                self.raw.lock().unwrap().insert(key, frame[13..].to_vec());
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

    // Wait for the connection, then create the scratch session on the private server, with the
    // tmux the core found (it may not be on the login shell's PATH).
    wait_for("host details", Duration::from_secs(30), || rec.facts.lock().unwrap().is_some()).await;
    let tmux = rec.facts.lock().unwrap().as_ref().and_then(|f| f.tmux_path.clone()).map_or_else(|| "tmux".to_string(), |p| format!("'{p}'"));
    let mut created = false;
    for _ in 0..50 {
        if let Ok(out) = core
            .exec(&host, &format!("{tmux} -L {socket} new-session -d -s scratch -x 90 -y 20 'bash --norc --noprofile'"))
            .await
        {
            assert!(out.success(), "new-session failed: {}", out.stderr_str());
            created = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(created, "never connected");
    // New panes run a bare bash: a login shell would run the user's rc files, and processes they
    // start (an ssh-agent, say) outlive the test.
    core.exec(&host, &format!("{tmux} -L {socket} set -g default-command 'bash --norc --noprofile'")).await.map_err(anyhow::Error::msg)?;
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

    // --- sizing: stamping, resize (pins + RESET at the new size), release, split windows
    let pane = |k: u32| rec.panes.lock().unwrap().iter().find(|p| p.key == k).cloned();
    wait_for("expanding stamps a stable @chm_id", Duration::from_secs(5), || pane(key).is_some_and(|p| p.chm_id.is_some())).await;
    let resets_before = rec.resets.lock().unwrap().get(&key).copied().unwrap_or(0);
    let outcome = core.resize_pane(key, 100, 30).await.map_err(anyhow::Error::msg)?;
    println!("     resize outcome: {outcome:?}");
    wait_for("pane is 100x30 and pinned", Duration::from_secs(5), || {
        pane(key).is_some_and(|p| (p.width, p.height, p.tmux.as_ref().is_some_and(|t| t.sized)) == (100, 30, true))
    })
    .await;
    wait_for("fresh RESET after resize", Duration::from_secs(5), || {
        rec.resets.lock().unwrap().get(&key).copied().unwrap_or(0) > resets_before
    })
    .await;
    let wsize = core.exec(&host, &format!("{tmux} -L {socket} show-options -wqv -t scratch window-size")).await.map_err(anyhow::Error::msg)?;
    assert_eq!(wsize.stdout_str().trim(), "manual", "resize pins window-size");
    core.release_pane_size(key);
    wait_for("release un-pins", Duration::from_secs(5), || pane(key).is_some_and(|p| p.tmux.as_ref().is_some_and(|t| !t.sized))).await;
    let wsize = core.exec(&host, &format!("{tmux} -L {socket} show-options -wqv -t scratch window-size")).await.map_err(anyhow::Error::msg)?;
    assert_eq!(wsize.stdout_str().trim(), "", "release restores the window's own (unset) window-size");
    core.exec(&host, &format!("{tmux} -L {socket} split-window -h -t scratch")).await.map_err(anyhow::Error::msg)?;
    wait_for("split window seen", Duration::from_secs(5), || pane(key).is_some_and(|p| p.tmux.as_ref().is_some_and(|t| t.window_panes == 2))).await;
    core.resize_pane(key, 60, 20).await.map_err(anyhow::Error::msg)?;
    wait_for("split pane resized to ~60x20", Duration::from_secs(5), || {
        pane(key).is_some_and(|p| p.width.abs_diff(60) <= 1 && p.height == 20)
    })
    .await;
    core.release_pane_size(key);
    let split = rec.panes.lock().unwrap().iter().find(|p| p.key != key && p.tmux.as_ref().is_some_and(|t| t.window_panes == 2)).map(|p| p.key);
    if let Some(k) = split {
        let _ = core.terminate_pane(k, true).await;
    }

    // --- labels: stored on the tmux pane, and changes made elsewhere arrive via the subscription
    let pane_id = pane(key).and_then(|p| p.tmux).expect("tmux pane").pane_id;
    core.set_pane_labels(key, vec!["alpha".into(), "beta".into(), "alpha".into()]);
    wait_for("labels applied (deduplicated)", Duration::from_secs(5), || pane(key).is_some_and(|p| p.labels == ["alpha", "beta"])).await;
    let stored = core.exec(&host, &format!("{tmux} -L {socket} show-options -pqv -t '{pane_id}' @chm_labels")).await.map_err(anyhow::Error::msg)?;
    assert_eq!(stored.stdout_str().trim(), "alpha,beta", "labels stored in @chm_labels");
    core.exec(&host, &format!("{tmux} -L {socket} set-option -p -t '{pane_id}' @chm_labels gamma")).await.map_err(anyhow::Error::msg)?;
    wait_for("label change from another client seen", Duration::from_secs(5), || pane(key).is_some_and(|p| p.labels == ["gamma"])).await;
    core.set_pane_labels(key, vec![]);
    wait_for("labels cleared", Duration::from_secs(5), || pane(key).is_some_and(|p| p.labels.is_empty())).await;

    // --- names: `@chm_name`, and the window's name while the pane has it to itself (put back
    // when the name is cleared)
    wait_for("window back to one pane", Duration::from_secs(5), || pane(key).is_some_and(|p| p.tmux.as_ref().is_some_and(|t| t.window_panes == 1))).await;
    let naming = || async {
        let out = core
            .exec(&host, &format!("{tmux} -L {socket} display -p -t '{pane_id}' '#{{window_name}}|#{{@chm_name}}|#{{automatic-rename}}|#{{@chm_window_name}}'"))
            .await
            .map_err(anyhow::Error::msg)?;
        anyhow::Ok(out.stdout_str().trim_end().to_string())
    };
    core.rename_pane(key, Some("  PR #7\tfix ".into()));
    wait_for("pane named", Duration::from_secs(5), || {
        pane(key).is_some_and(|p| p.name.as_deref() == Some("PR #7 fix") && p.tmux.as_ref().is_some_and(|t| t.window_name == "PR #7 fix"))
    })
    .await;
    assert_eq!(naming().await?, "PR #7 fix|PR #7 fix|0|=", "window renamed, automatic name saved");
    core.exec(&host, &format!("{tmux} -L {socket} set-option -p -t '{pane_id}' @chm_name elsewhere")).await.map_err(anyhow::Error::msg)?;
    wait_for("name set by another client seen", Duration::from_secs(5), || pane(key).is_some_and(|p| p.name.as_deref() == Some("elsewhere"))).await;
    core.rename_pane(key, Some(" ".into()));
    wait_for("name cleared", Duration::from_secs(5), || pane(key).is_some_and(|p| p.name.is_none())).await;
    assert_eq!(naming().await?.split('|').skip(1).collect::<Vec<_>>(), ["", "1", ""], "tmux names the window again");
    println!("ok   pane names (window renamed and given back)");

    // --- a session destroyed under our control client (its last pane closed) must not crash
    // tmux <= 3.6: an all-panes subscription's timer dereferences the NULL session. Freezing
    // our client keeps it around after its session is gone, as a slow connection would.
    core.exec(&host, &format!("{tmux} -L {socket} new-session -d -s doomed 'bash --norc --noprofile'")).await.map_err(anyhow::Error::msg)?;
    wait_for("second session's pane discovered", Duration::from_secs(10), || {
        rec.panes.lock().unwrap().iter().any(|p| p.tmux.as_ref().is_some_and(|t| t.session_name == "doomed"))
    })
    .await;
    let script = format!(
        r#"T="{tmux} -L {socket}"
pid=$($T list-clients -F '#{{client_pid}} #{{client_session}} #{{client_control_mode}}' | awk '$2=="doomed" && $3==1 {{print $1; exit}}')
[ -n "$pid" ] || {{ echo "no control client on doomed"; exit 1; }}
kill -STOP "$pid"; $T kill-session -t doomed; sleep 2.5
if $T ls >/dev/null 2>&1; then echo ALIVE; else echo CRASHED; fi
kill -CONT "$pid""#
    );
    let out = core.exec(&host, &script).await.map_err(anyhow::Error::msg)?;
    assert!(out.stdout_str().contains("ALIVE"), "tmux survived its session closing under our client: {}", out.stdout_str().trim());
    wait_for("pane of the closed session removed", Duration::from_secs(10), || {
        !rec.panes.lock().unwrap().iter().any(|p| p.tmux.as_ref().is_some_and(|t| t.session_name == "doomed"))
    })
    .await;
    println!("ok   tmux survives a session closing under our control client");

    // --- pasted images: saved under ~/.cache/consuls/pastes, never overwriting
    let image: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
    let path = core.save_paste(&host, image.clone(), "PNG").await.map_err(anyhow::Error::msg)?;
    assert!(path.contains("/.cache/consuls/pastes/paste-") && path.ends_with(".png"), "paste saved at {path}");
    let back = core.read_bytes(&host, &path).await.map_err(anyhow::Error::msg)?;
    assert_eq!(back, image, "pasted image arrives byte for byte");
    assert!(core.save_paste(&host, vec![1], "svg").await.is_err(), "only types agents read");
    core.exec(&host, &format!("rm -f '{path}'")).await.map_err(anyhow::Error::msg)?;
    println!("ok   pasted image saved on the host ({path})");

    // --- bells: off by default for a shell; once on, a real BEL pings (a BEL that only ends
    // an OSC title doesn't)
    let bell_alerts = || rec.alerts.lock().unwrap().iter().filter(|a| a.kind == AlertKind::Bell && a.key == Some(key)).count();
    core.stream_pane(key, false);
    core.set_focus(FocusState { expanded: None, window_focused: false });
    core.send_text(key, r"printf '\a'".into());
    core.send_keys(key, vec!["Enter".into()]);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(bell_alerts(), 0, "a shell's bell doesn't ping by default");
    core.set_pane_bell(key, Some(true));
    wait_for("bell pings turned on (@chm_bell)", Duration::from_secs(5), || pane(key).is_some_and(|p| p.bell == Some(true) && p.bell_pings)).await;
    core.send_text(key, r"printf '\033]0;chm-title\007'".into());
    core.send_keys(key, vec!["Enter".into()]);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(bell_alerts(), 0, "BEL terminating an OSC title isn't a bell");
    core.send_text(key, r"printf '\a'".into());
    core.send_keys(key, vec!["Enter".into()]);
    wait_for("a real bell pings once", Duration::from_secs(5), || bell_alerts() == 1).await;
    core.ack_pane(key);
    core.set_pane_bell(key, None);
    wait_for("bell setting cleared", Duration::from_secs(5), || pane(key).is_some_and(|p| p.bell.is_none() && !p.bell_pings)).await;
    core.stream_pane(key, true);

    // --- direct shell: a plain PTY session with no tmux; the core answers terminal queries
    let spec = NewPaneSpec {
        host: host.clone(),
        cwd: "/tmp".into(),
        harness: Harness::Shell,
        name: None,
        session: None,
        args: None,
        direct: Some(true),
        shell: None,
    };
    let dkey = core.create_pane(spec).await.map_err(anyhow::Error::msg)?;
    wait_for("direct pane listed", Duration::from_secs(5), || pane(dkey).is_some_and(|p| p.kind == PaneKind::Direct && p.ended.is_none())).await;
    wait_for("direct tile frame", Duration::from_secs(5), || rec.tiles.lock().unwrap().contains_key(&dkey)).await;
    core.stream_pane(dkey, true);
    wait_for("direct RESET on expand", Duration::from_secs(5), || rec.resets.lock().unwrap().contains_key(&dkey)).await;
    let draw = |k: u32| String::from_utf8_lossy(rec.raw.lock().unwrap().get(&k).map(Vec::as_slice).unwrap_or(&[])).into_owned();
    core.send_text(dkey, "cd /tmp; printf 'direct-%s\\n' $((6*7)); printf '\\033[6n'; IFS= read -rs -t 3 -d R r; echo \"dsr:${r#??}\"".into());
    core.send_keys(dkey, vec!["Enter".into()]);
    wait_for("typed into the direct shell", Duration::from_secs(5), || draw(dkey).contains("direct-42")).await;
    wait_for("cursor-position query answered by the core", Duration::from_secs(6), || {
        draw(dkey).split("dsr:").nth(2).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    })
    .await;
    let resets_before = rec.resets.lock().unwrap().get(&dkey).copied().unwrap_or(0);
    core.resize_pane(dkey, 100, 30).await.map_err(anyhow::Error::msg)?;
    wait_for("direct pane resized, with a fresh RESET", Duration::from_secs(5), || {
        pane(dkey).is_some_and(|p| (p.width, p.height) == (100, 30)) && rec.resets.lock().unwrap().get(&dkey).copied().unwrap_or(0) > resets_before
    })
    .await;
    // The direct shell is a login shell; stop an ssh-agent its rc files may have started.
    core.send_text(dkey, "[ -n \"$SSH_AGENT_PID\" ] && kill $SSH_AGENT_PID; stty size".into());
    core.send_keys(dkey, vec!["Enter".into()]);
    wait_for("the shell sees the new size", Duration::from_secs(5), || draw(dkey).contains("30 100")).await;
    // Shell integration: the folder follows `cd`; OSC 52 copies reach the UI while focused.
    core.send_text(dkey, "cd /usr/share".into());
    core.send_keys(dkey, vec!["Enter".into()]);
    wait_for("cd reported as the direct pane's folder", Duration::from_secs(5), || pane(dkey).is_some_and(|p| p.current_path == "/usr/share")).await;
    // …and the user's own rc files still ran: a tmux only their interactive rc puts on PATH
    // (e.g. ~/.homebrew on the Mac) is found.
    let tmux_path = rec.facts.lock().unwrap().as_ref().and_then(|f| f.tmux_path.clone());
    if let Some(tmux_path) = tmux_path {
        core.send_text(dkey, "echo \"rc-tmux:$(command -v tmux)\"".into());
        core.send_keys(dkey, vec!["Enter".into()]);
        wait_for("the user's rc files ran (PATH has their tmux)", Duration::from_secs(5), || draw(dkey).contains(&format!("rc-tmux:{tmux_path}"))).await;
    }
    core.set_focus(FocusState { expanded: Some(dkey), window_focused: true });
    core.send_text(dkey, "printf '\\033]52;c;ZGlyZWN0LWNvcHk=\\a'".into());
    core.send_keys(dkey, vec!["Enter".into()]);
    wait_for("OSC 52 copy reaches the UI", Duration::from_secs(5), || {
        rec.clipboard.lock().unwrap().iter().any(|(k, t)| *k == dkey && t == "direct-copy")
    })
    .await;
    core.set_focus(FocusState { expanded: None, window_focused: false });
    core.send_text(dkey, "sh ~/.local/share/consuls/chm-hook.sh claude Stop </dev/null".into());
    core.send_keys(dkey, vec!["Enter".into()]);
    wait_for("hook inside the direct shell reaches its pane (CHM_PANE)", Duration::from_secs(10), || {
        rec.attention.lock().unwrap().get(&dkey).is_some_and(|a| a.attention == AttentionLevel::Unacked)
    })
    .await;
    core.ack_pane(dkey);

    // Drop the connection: it must come back on its own, with the same pane keys, and the
    // expanded pane must get a fresh RESET without the UI asking again. The direct shell is
    // lost and says so, but stays listed (readable) and is never revived.
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
    wait_for("direct pane marked ended, still listed", Duration::from_secs(5), || pane(dkey).is_some_and(|p| p.ended.is_some())).await;
    println!("     (ended: {:?})", pane(dkey).and_then(|p| p.ended));
    let resets_before = rec.resets.lock().unwrap().get(&dkey).copied().unwrap_or(0);
    core.stream_pane(dkey, true);
    wait_for("an ended pane still re-opens with its history", Duration::from_secs(5), || {
        rec.resets.lock().unwrap().get(&dkey).copied().unwrap_or(0) > resets_before && draw(dkey).contains("direct-42")
    })
    .await;
    core.terminate_pane(dkey, true).await.map_err(anyhow::Error::msg)?;
    wait_for("dismissed direct pane removed", Duration::from_secs(5), || pane(dkey).is_none()).await;

    // --- files: explorer operations and git status, in a scratch dir
    let tmp = core.exec(&host, "mktemp -d /tmp/chm-fs-XXXXXX").await.map_err(anyhow::Error::msg)?.stdout_str().trim().to_string();
    assert!(tmp.starts_with("/tmp/chm-fs-"), "mktemp: {tmp}");
    core.fs_op(&host, FsOp::Mkdir { path: format!("{tmp}/src") }).await.map_err(anyhow::Error::msg)?;
    core.fs_op(&host, FsOp::CreateFile { path: format!("{tmp}/src/a.rs") }).await.map_err(anyhow::Error::msg)?;
    assert!(core.fs_op(&host, FsOp::CreateFile { path: format!("{tmp}/src/a.rs") }).await.is_err(), "create never overwrites");
    core.fs_op(&host, FsOp::CreateFile { path: format!("{tmp}/notes.txt") }).await.map_err(anyhow::Error::msg)?;
    assert!(
        core.fs_op(&host, FsOp::Rename { from: format!("{tmp}/notes.txt"), to: format!("{tmp}/src/a.rs") }).await.is_err(),
        "rename never replaces"
    );
    core.fs_op(&host, FsOp::Rename { from: format!("{tmp}/notes.txt"), to: format!("{tmp}/README.md") }).await.map_err(anyhow::Error::msg)?;
    let listing = core.list_dir(&host, &tmp).await.map_err(anyhow::Error::msg)?;
    let names: Vec<(String, bool)> = listing.entries.iter().map(|e| (e.name.clone(), e.is_dir)).collect();
    assert_eq!(names, vec![("src".to_string(), true), ("README.md".to_string(), false)], "dirs first");
    assert_eq!(core.fs_count(&host, &tmp).await.map_err(anyhow::Error::msg)?, 3);
    println!("ok   fs: mkdir, create (no overwrite), rename (no replace), list, count");
    assert!(core.git_status(&host, &tmp).await.map_err(anyhow::Error::msg)?.is_none(), "not a repo yet");
    let setup = format!(
        "cd {tmp} && git init -q && printf 'target/\\n' > .gitignore && mkdir target && echo x > target/out && git add .gitignore src/a.rs && git -c user.name=t -c user.email=t@t commit -qm init && echo changed > src/a.rs"
    );
    let out = core.exec(&host, &setup).await.map_err(anyhow::Error::msg)?;
    assert!(out.success(), "git setup: {}", out.stderr_str());
    let src = format!("{tmp}/src");
    let (a, b) = tokio::join!(core.git_status(&host, &src), core.git_status(&host, &src));
    let st = a.map_err(anyhow::Error::msg)?.expect("a repo");
    assert_eq!(b.map_err(anyhow::Error::msg)?, Some(st.clone()), "concurrent callers share one run");
    assert_eq!(st.root, tmp);
    let status = |p: &str| st.entries.iter().find(|e| e.path == p).map(|e| e.status);
    assert_eq!(status("src/a.rs"), Some(GitFileStatus::Modified));
    assert_eq!(status("README.md"), Some(GitFileStatus::Untracked));
    assert_eq!(status("target/"), Some(GitFileStatus::Ignored));
    println!("ok   git status: root {}, branch {:?}, {} entries", st.root, st.branch, st.entries.len());
    use chm_core::fs::git::HeadVersion;
    let head = core.git_head(&host, &format!("{tmp}/src/a.rs")).await.map_err(anyhow::Error::msg)?;
    assert!(matches!(head, HeadVersion::Text { ref text } if text.is_empty()), "committed (empty) version: {head:?}");
    let untracked = core.git_head(&host, &format!("{tmp}/README.md")).await.map_err(anyhow::Error::msg)?;
    assert_eq!(untracked, HeadVersion::Untracked);
    let outside = core.git_head(&host, "/etc/hostname").await.map_err(anyhow::Error::msg)?;
    assert_eq!(outside, HeadVersion::NotInRepo);
    println!("ok   git HEAD versions: committed, untracked, outside a repo");
    // --- editing: byte-exact saves, truncation, conflicts, symlinks, modes
    let f = format!("{tmp}/crlf.txt");
    let prep = format!(r"printf '\357\273\277one\r\ntwo\r\n' > {f} && chmod 755 {f} && ln -s crlf.txt {tmp}/link.txt && cksum < {f}");
    let before = core.exec(&host, &prep).await.map_err(anyhow::Error::msg)?.stdout_str().trim().to_string();
    let FileContent::Text { text, bom, stamp } = core.read_file(&host, &format!("{tmp}/link.txt")).await.map_err(anyhow::Error::msg)? else {
        panic!("expected text")
    };
    assert!(bom && text == "one\r\ntwo\r\n", "BOM stripped, CRLF kept: {text:?}");
    let stamp = core.write_file(&host, &format!("{tmp}/link.txt"), text.clone(), bom, Some(stamp)).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    // POSIX cksum; stat differs between GNU (-c) and BSD/macOS (-f).
    let check = format!("cksum < {f}; [ -L {tmp}/link.txt ] && echo link; stat -c %a {f} 2>/dev/null || stat -f %Lp {f}");
    let after = core.exec(&host, &check).await.map_err(anyhow::Error::msg)?.stdout_str();
    let mut lines = after.lines();
    assert_eq!(lines.next(), Some(before.as_str()), "unedited CRLF+BOM save is byte-identical");
    assert_eq!(lines.next(), Some("link"), "a symlink stays a symlink");
    assert_eq!(lines.next(), Some("755"), "the mode is kept");
    let stamp = core.write_file(&host, &f, "x".into(), false, Some(stamp)).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    assert_eq!(core.exec(&host, &format!("cat {f}")).await.map_err(anyhow::Error::msg)?.stdout_str(), "x", "shorter content truncates");
    core.exec(&host, &format!("printf y > {f}")).await.map_err(anyhow::Error::msg)?;
    let res = core.write_file(&host, &f, "z".into(), false, Some(stamp)).await;
    assert!(matches!(res, Err(SaveError::Conflict { .. })), "an outside edit (same size, same second) is a conflict: {res:?}");
    let current = core.stat_file(&host, &f).await.map_err(anyhow::Error::msg)?.expect("exists");
    assert_eq!(current.size, 1);
    println!("ok   editing: byte-exact CRLF+BOM, symlink kept, mode kept, truncation, conflict");

    core.fs_op(&host, FsOp::Remove { path: format!("{tmp}/src") }).await.map_err(anyhow::Error::msg)?;
    core.fs_op(&host, FsOp::Remove { path: tmp.clone() }).await.map_err(anyhow::Error::msg)?;
    assert!(core.list_dir(&host, &tmp).await.is_err(), "scratch dir removed");
    println!("ok   fs: recursive remove");

    // --- lifecycle: list dir, create, hide, terminate
    let listing = core.list_dir(&host, "~").await.map_err(anyhow::Error::msg)?;
    println!("ok   list_dir ~ -> {} ({} entries)", listing.path, listing.entries.len());
    let harness = args.get(2).and_then(|h| Harness::from_name(h)).unwrap_or(Harness::Shell);
    let cwd = args.get(3).cloned().unwrap_or_else(|| listing.path.clone());
    let spec = NewPaneSpec { host: host.clone(), cwd: cwd.clone(), harness, name: None, session: None, args: None, direct: None, shell: None };
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

    // kill-server leaves the socket file behind.
    let _ = core.exec(&host, &format!("p=$({tmux} -L {socket} display -p '#{{socket_path}}'); {tmux} -L {socket} kill-server; rm -f \"$p\"")).await;
    core.disconnect(&host);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}
