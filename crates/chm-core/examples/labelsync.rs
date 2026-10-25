//! Label definitions shared through a machine's tmux, on a private tmux server (macOS/Linux):
//!
//!   cargo run -p chm-core --example labelsync
//!
//! Two cores with their own scratch config folders (think desktop and phone server) watch the
//! same private tmux server as This PC. Their labels meet in `@chm_label_defs` (one config from
//! before labels were shared), then edits on either side reach the other: create, rename,
//! reorder, delete, a rename on both at once, a third device writing the option, and the tmux
//! server restarting (its labels come back from the cores). Kills the private server after.

use std::sync::Arc;
use std::time::{Duration, Instant};

use chm_core::labels;
use chm_core::link::Link;
use chm_core::model::{CoreEvent, FocusState};
use chm_core::{Core, Sink};

struct Quiet;

impl Sink for Quiet {
    fn event(&self, event: CoreEvent) {
        if let CoreEvent::Notice { message, .. } = event {
            println!("  notice: {message}");
        }
    }
    fn frame(&self, _frame: Vec<u8>) {}
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

/// (id, name) in order, as the core's config has them.
fn labels_of(core: &Core) -> Vec<(String, String)> {
    core.snapshot().config.labels.into_iter().map(|l| (l.id, l.name)).collect()
}

fn names(core: &Core) -> Vec<String> {
    labels_of(core).into_iter().map(|(_, n)| n).collect()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if cfg!(windows) {
        println!("this check runs on macOS/Linux (a native tmux)");
        return Ok(());
    }
    let socket = format!("chm-labelsync-{}", std::process::id());
    let dir = std::env::temp_dir().join(format!("chm-labelsync-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("state"))?;
    // SAFETY: set before any other thread reads the environment.
    unsafe {
        std::env::set_var("CHM_TMUX_SOCKET", &socket);
        std::env::set_var("XDG_STATE_HOME", dir.join("state"));
    }
    let sh = Link::Local(chm_core::link::LocalSh::posix(Vec::new()));
    let tmux = format!("tmux -L {socket} -f /dev/null");
    let run = |script: String| {
        let sh = sh.clone();
        async move {
            let out = sh.exec(&script, Duration::from_secs(15)).await?;
            anyhow::ensure!(out.success(), "{script}: {}", out.stderr_str().trim());
            Ok::<_, anyhow::Error>(out.stdout_str().trim().to_string())
        }
    };
    if run("command -v tmux".into()).await.is_err() {
        println!("no tmux here; nothing to check");
        return Ok(());
    }
    // A session with a bare shell, before the cores look (they poll slowly while there's none).
    run(format!("{tmux} new-session -d -s labels -x 80 -y 24 sh")).await?;

    // One config from before labels were shared (no times), one from a device that has its own.
    for (name, json) in [
        ("a", r##"{ "labels": [ { "id": "terrarium", "name": "terrarium", "color": "#4ade9a" }, { "id": "urgent", "name": "urgent", "color": "#ff6b81" } ] }"##),
        ("b", r##"{ "labels": [ { "id": "work", "name": "Work", "color": "#6aa9ff", "updated": 1 } ] }"##),
    ] {
        std::fs::create_dir_all(dir.join(name))?;
        std::fs::write(dir.join(name).join("config.json"), json)?;
    }
    let a = Core::new(dir.join("a"), Arc::new(Quiet));
    let b = Core::new(dir.join("b"), Arc::new(Quiet));
    for core in [&a, &b] {
        core.start();
        core.set_focus(FocusState { expanded: None, window_focused: false, ..Default::default() });
    }

    let result = checks(&a, &b, &run, &tmux, &dir).await;

    match run(format!("{tmux} kill-server")).await {
        Ok(_) => println!("     private tmux server stopped"),
        Err(e) => println!("     couldn't stop the private tmux server: {e}"),
    }
    let _ = run(format!("rm -f \"${{TMUX_TMPDIR:-/tmp}}/tmux-$(id -u)/{socket}\"")).await;
    let _ = std::fs::remove_dir_all(&dir);
    result?;
    println!("all label sync checks passed");
    Ok(())
}

async fn checks<F, Fut>(a: &Arc<Core>, b: &Arc<Core>, run: &F, tmux: &str, dir: &std::path::Path) -> anyhow::Result<()>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<String>>,
{
    let same = || labels_of(a) == labels_of(b);
    let held = || async { labels::decode(&run(format!("{tmux} show-options -gqv {}", labels::OPTION)).await.unwrap_or_default()) };

    // b's order is the newest (both are from before sharing, time 0, so content decides); a's
    // labels follow it, by id.
    wait_for("the two devices' labels meet", Duration::from_secs(40), || same() && names(a) == ["Work", "terrarium", "urgent"]).await?;
    let on_tmux = held().await.map_err(|e| anyhow::anyhow!("option unreadable: {e:?}"))?;
    anyhow::ensure!(on_tmux.live().len() == 3, "the tmux server holds all three: {on_tmux:?}");

    a.create_label("Phone", "#a192ff");
    wait_for("a label made on one device reaches the other", Duration::from_secs(10), || names(b) == ["Work", "terrarium", "urgent", "Phone"]).await?;

    b.update_label(chm_core::model::LabelDef { id: "urgent".into(), name: "Urgent!".into(), color: "#ff0000".into(), updated: 0 });
    wait_for("a rename too", Duration::from_secs(10), || names(a).contains(&"Urgent!".to_string())).await?;

    a.reorder_labels(vec!["urgent".into(), "phone".into()]);
    wait_for("and the order", Duration::from_secs(10), || names(b) == ["Urgent!", "Phone", "Work", "terrarium"]).await?;

    b.delete_label("terrarium");
    wait_for("and a delete", Duration::from_secs(10), || same() && !names(a).contains(&"terrarium".to_string())).await?;
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("a").join("config.json"))?)?;
    anyhow::ensure!(config["labelSync"]["deleted"].get("terrarium").is_some(), "the delete is remembered in config.json: {config}");

    // Both rename the same label at once: whichever is newer, everywhere.
    a.update_label(chm_core::model::LabelDef { id: "work".into(), name: "Job".into(), color: "#6aa9ff".into(), updated: 0 });
    b.update_label(chm_core::model::LabelDef { id: "work".into(), name: "Office".into(), color: "#6aa9ff".into(), updated: 0 });
    wait_for("a rename on both at once settles the same way", Duration::from_secs(10), || {
        same() && names(a).iter().any(|n| n == "Job" || n == "Office")
    })
    .await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    anyhow::ensure!(same(), "still agreeing a moment later: {:?} vs {:?}", labels_of(a), labels_of(b));
    let settled = run(format!("{tmux} show-options -gqv {}", labels::OPTION)).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    anyhow::ensure!(run(format!("{tmux} show-options -gqv {}", labels::OPTION)).await? == settled, "nobody writes once they agree");
    println!("ok   nobody writes once they agree");

    // A third device leaves a label on the machine.
    let mut third = held().await.map_err(|e| anyhow::anyhow!("option unreadable: {e:?}"))?;
    third.create("From elsewhere", "#5fd4c8", labels::now_ms());
    run(format!("{tmux} set-option -g {} '{}'", labels::OPTION, third.encode())).await?;
    wait_for("a label another device left on the machine shows up on both", Duration::from_secs(10), || {
        names(a).last().map(String::as_str) == Some("From elsewhere") && same()
    })
    .await?;
    anyhow::ensure!(settled != third.encode(), "the option changed");

    // The tmux server restarts: its labels come back from the devices.
    run(format!("{tmux} kill-server")).await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    run(format!("{tmux} new-session -d -s labels2 -x 80 -y 24 sh")).await?;
    let want: Vec<String> = names(a);
    let started = Instant::now();
    loop {
        let back = held().await.map(|set| set.live().into_iter().map(|l| l.name).collect::<Vec<_>>());
        if back.as_ref() == Ok(&want) {
            println!("ok   a restarted tmux server gets the labels back ({:?})", started.elapsed());
            break;
        }
        anyhow::ensure!(started.elapsed() < Duration::from_secs(60), "a restarted tmux server didn't get the labels back: {back:?}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    anyhow::ensure!(same(), "the devices still agree");
    Ok(())
}
