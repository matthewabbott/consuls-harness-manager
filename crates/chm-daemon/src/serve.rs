//! Publishing the web app on the tailnet: a foreground `tailscale serve`, as the server's child.
//! tailscaled drops a foreground serve's config when that process ends (even on `kill -9`), so
//! the address is gone as soon as the server is.

use std::time::Duration;

use tokio::sync::watch;
use tracing::{info, warn};

/// Keeps `tailscale serve --https=<https> <target>` running until `stop`; `target` is
/// `unix:<socket>` (or `http://<address>`).
pub async fn keep_serving(target: String, https: u16, mut stop: watch::Receiver<bool>) {
    let Some(cli) = chm_core::tailscale::find_cli() else {
        warn!("no tailscale CLI: the web app isn't published on the tailnet");
        return;
    };
    let mut backoff = Duration::from_secs(5);
    loop {
        let mut cmd = tokio::process::Command::new(&cli);
        cmd.args(["serve", &format!("--https={https}"), &target])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true);
        // Linux: it ends with us even if we're killed outright (macOS has no equivalent; there
        // tmux hangs up on the pane's process group).
        #[cfg(target_os = "linux")]
        // SAFETY: prctl is async-signal-safe; it only asks for a signal when our parent dies.
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        match cmd.spawn() {
            Ok(mut child) => {
                info!("published on the tailnet (https port {https})");
                tokio::select! {
                    status = child.wait() => warn!("tailscale serve ended ({status:?}); again in {}s", backoff.as_secs()),
                    _ = stop.changed() => {
                        let _ = child.kill().await;
                        return;
                    }
                }
            }
            Err(e) => warn!("couldn't start tailscale serve: {e}"),
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}
