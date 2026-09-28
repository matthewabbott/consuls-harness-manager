//! End-to-end check of "This PC" shells (direct panes on a local pseudo-console):
//!
//!   cargo run -p chm-core --example localtest
//!
//! For each local shell found (PowerShell, Git Bash, cmd, … or the login shell elsewhere):
//! start it, type into it, resize it, fire the hook script from inside it (CHM_PANE routing
//! through the local events file), exit it (pane marked ended, still readable), dismiss it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chm_core::harness::Harness;
use chm_core::local::{self, LOCAL_HOST};
use chm_core::model::{AttentionLevel, CoreEvent, FocusState, NewPaneSpec, PaneAttention, PaneInfo};
use chm_core::{Core, Sink};

#[derive(Default)]
struct Recorder {
    panes: Mutex<Vec<PaneInfo>>,
    raw: Mutex<HashMap<u32, Vec<u8>>>,
    attention: Mutex<HashMap<u32, PaneAttention>>,
}

impl Sink for Recorder {
    fn event(&self, event: CoreEvent) {
        match event {
            CoreEvent::Panes { host, panes } if host == LOCAL_HOST => *self.panes.lock().unwrap() = panes,
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
    let dir = std::env::temp_dir().join(format!("chm-localtest-{}", std::process::id()));
    let rec = Arc::new(Recorder::default());
    let core = Core::new(dir.clone(), rec.clone());
    core.start();
    core.set_focus(FocusState { expanded: None, window_focused: false });
    let assets = local::ensure_assets().map_err(anyhow::Error::msg)?;
    println!("     hook assets in {} (sh: {})", assets.dir, assets.sh);

    let shells = core.local_shells();
    println!("     shells: {}", shells.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", "));
    for shell in shells.iter().filter(|s| !s.id.starts_with("wsl:")) {
        println!("--- {} ({})", shell.name, shell.path);
        let spec = NewPaneSpec {
            host: LOCAL_HOST.into(),
            cwd: "~".into(),
            harness: Harness::Shell,
            name: None,
            session: None,
            args: None,
            direct: Some(true),
            shell: Some(shell.id.clone()),
        };
        let key = core.create_pane(spec).await.map_err(anyhow::Error::msg)?;
        let pane = |k: u32| rec.panes.lock().unwrap().iter().find(|p| p.key == k).cloned();
        let draw = |k: u32| String::from_utf8_lossy(rec.raw.lock().unwrap().get(&k).map(Vec::as_slice).unwrap_or(&[])).into_owned();
        wait_for("pane listed", Duration::from_secs(5), || pane(key).is_some()).await;
        core.stream_pane(key, true);
        tokio::time::sleep(Duration::from_millis(1500)).await; // let the shell print its prompt

        // The typed command never contains the marker literally; only its output does.
        let cmds: &[&str] = match shell.id.as_str() {
            "cmd" => &["set /a x=6*7 >nul", "echo local-%x%"],
            "pwsh" | "powershell" => &["Write-Output \"local-$(6*7)\""],
            _ => &["echo \"local-$((6*7))\""],
        };
        for c in cmds {
            core.send_text(key, c.to_string());
            core.send_keys(key, vec!["Enter".into()]);
        }
        let started = Instant::now();
        while !draw(key).contains("local-42") {
            if started.elapsed() > Duration::from_secs(10) {
                println!("     output so far: {:?}", draw(key).chars().rev().take(600).collect::<String>().chars().rev().collect::<String>());
                panic!("typed command didn't run");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        println!("ok   typed command runs ({:?})", started.elapsed());

        core.resize_pane(key, 100, 30).await.map_err(anyhow::Error::msg)?;
        wait_for("resized", Duration::from_secs(5), || pane(key).is_some_and(|p| (p.width, p.height) == (100, 30))).await;
        let size_cmd = match shell.id.as_str() {
            "pwsh" | "powershell" => Some("Write-Output \"size=$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)\""),
            "cmd" => None,
            _ => Some("echo \"size=$(tput cols)x$(tput lines)\""),
        };
        if let Some(c) = size_cmd {
            core.send_text(key, c.into());
            core.send_keys(key, vec!["Enter".into()]);
            wait_for("the shell sees 100x30", Duration::from_secs(10), || draw(key).contains("size=100x30")).await;
        }

        let hook = match shell.id.as_str() {
            "pwsh" | "powershell" => format!("& '{}' '{}' claude Stop", assets.sh, assets.hook),
            "cmd" => format!("\"{}\" \"{}\" claude Stop <nul", assets.sh, assets.hook),
            _ => format!("sh '{}' claude Stop </dev/null", assets.hook),
        };
        core.send_text(key, hook);
        core.send_keys(key, vec!["Enter".into()]);
        wait_for("hook inside the shell reaches its pane", Duration::from_secs(10), || {
            rec.attention.lock().unwrap().get(&key).is_some_and(|a| a.attention == AttentionLevel::Unacked)
        })
        .await;
        core.ack_pane(key);

        core.send_text(key, "exit".into());
        core.send_keys(key, vec!["Enter".into()]);
        wait_for("exit marks the pane ended", Duration::from_secs(10), || pane(key).is_some_and(|p| p.ended.is_some())).await;
        println!("     (ended: {:?})", pane(key).and_then(|p| p.ended));
        core.terminate_pane(key, true).await.map_err(anyhow::Error::msg)?;
        wait_for("dismissed", Duration::from_secs(5), || pane(key).is_none()).await;
    }
    println!("all local checks passed");
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}
