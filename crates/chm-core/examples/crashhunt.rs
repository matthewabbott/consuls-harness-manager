//! Stress test for tmux under the app's traffic, on a private tmux server:
//!
//!   crashhunt setup  <host> <user> <socket>          sessions (grouped, split, alt-screen) with busy panes
//!   crashhunt client <host> <user> <socket> <secs>   the app's core: attach, stream, resize, pin, label… then exit abruptly
//!   crashhunt check  <host> <user> <socket>          the server's pid (or "DEAD")
//!   crashhunt stop   <host> <user> <socket>          kill the private server
//!
//! Panes run plain `sh` (no rc files), so nothing lingers after `stop`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chm_core::model::{CoreEvent, HostConfig, PaneInfo};
use chm_core::{Core, Sink};

#[derive(Default)]
struct Panes(Mutex<Vec<PaneInfo>>);
impl Sink for Panes {
    fn event(&self, e: CoreEvent) {
        if let CoreEvent::Panes { panes, .. } = e
            && !panes.is_empty()
        {
            *self.0.lock().unwrap() = panes;
        }
    }
    fn frame(&self, _f: Vec<u8>) {}
}

const BUSY: &str = r#"sh -c 'i=0; while :; do i=$((i+1)); printf "\033]2;title %s\007line %s %s\n" $i $i "$(date +%s)"; sleep 0.01; done'"#;
const ALT: &str = r#"sh -c 'printf "\033[?1049h"; i=0; while :; do i=$((i+1)); printf "\033[H\033[2Jframe %s\n" $i; sleep 0.02; done'"#;

fn rand(n: u64) -> u64 {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64;
    (t ^ (t >> 7)) % n.max(1)
}

async fn core_for(host: &str, user: &str, socket: &str) -> (Arc<Core>, Arc<Panes>) {
    // SAFETY: set before the core (or any other thread) reads it.
    unsafe { std::env::set_var("CHM_TMUX_SOCKET", socket) };
    let dir = std::env::temp_dir().join(format!("chm-hunt-{}", std::process::id()));
    let sink = Arc::new(Panes::default());
    let core = Core::new(dir, sink.clone());
    core.start();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    core.upsert_host(HostConfig::new(host, user));
    (core, sink)
}

async fn exec(core: &Core, host: &str, script: &str) -> String {
    for _ in 0..50 {
        if let Ok(o) = core.exec(host, script).await {
            return o.stdout_str();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("never connected");
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (mode, host, user, socket) = (a[0].as_str(), a[1].as_str(), a[2].as_str(), a[3].as_str());
    let t = format!("tmux -L {socket}");
    match mode {
        "setup" => {
            let (core, _) = core_for(host, user, "chm-hunt-none").await;
            let (busy, alt) = (chm_core::ssh::exec::sh_quote(BUSY), chm_core::ssh::exec::sh_quote(ALT));
            // VERBOSE=1: tmux -vv, logs in /tmp/chm-hunt-log (to see why the server dies).
            let (pre, v) = if std::env::var("VERBOSE").is_ok() { ("mkdir -p /tmp/chm-hunt-log && cd /tmp/chm-hunt-log && ", "-vv ") } else { ("", "") };
            let script = format!(
                "{pre}{t} {v}-f /dev/null new-session -d -s a -x 120 -y 30 {busy} && {t} set -g default-command sh && \
                 {t} new-window -t a: {busy} && {t} split-window -t a: {busy} && \
                 {t} new-session -d -t a -s a2 && \
                 {t} new-session -d -s b -x 100 -y 25 {alt} && {t} new-window -t b: {busy} && \
                 {t} new-session -d -t b -s b2 && {t} display -p 'pid=#{{pid}}' 2>&1; echo done"
            );
            print!("{}", exec(&core, host, &script).await);
        }
        "check" | "stop" => {
            let (core, _) = core_for(host, user, "chm-hunt-none").await;
            let cmd = if mode == "check" { format!("{t} display -p '#{{pid}} #{{server_sessions}}' 2>/dev/null || echo DEAD") } else { format!("{t} kill-server; echo stopped") };
            print!("{}", exec(&core, host, &cmd).await);
        }
        "client" => {
            let secs: u64 = a[4].parse().unwrap();
            let (core, sink) = core_for(host, user, socket).await;
            let started = Instant::now();
            let mut ops = 0;
            while started.elapsed() < Duration::from_secs(secs) {
                let panes = sink.0.lock().unwrap().clone();
                if panes.is_empty() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                let p = &panes[rand(panes.len() as u64) as usize];
                // OPS=stream,resize,release,labels,visible limits what the client does.
                let allowed = std::env::var("OPS").unwrap_or_else(|_| "stream,resize,release,labels,visible".into());
                let ops_list: Vec<&str> = allowed.split(',').collect();
                match ops_list[rand(ops_list.len() as u64) as usize] {
                    "stream" => core.stream_pane(p.key, rand(2) == 0),
                    "resize" => {
                        let _ = core.resize_pane(p.key, 60 + rand(80) as u16, 15 + rand(30) as u16).await;
                    }
                    "release" => core.release_pane_size(p.key),
                    "labels" => core.set_pane_labels(p.key, if rand(2) == 0 { vec!["x".into()] } else { vec![] }),
                    "idle" => {}
                    _ => core.set_visible_panes(None),
                }
                ops += 1;
                tokio::time::sleep(Duration::from_millis(rand(200))).await;
            }
            eprintln!("client did {ops} ops; exiting abruptly");
            std::process::exit(0); // no detach: like the app being killed or the network dropping
        }
        _ => eprintln!("usage: see the file header"),
    }
}
