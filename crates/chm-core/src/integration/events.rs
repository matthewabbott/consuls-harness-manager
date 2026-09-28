//! Tails the host's `~/.local/state/consuls/events.jsonl` (written by chm-hook.sh) over one
//! exec channel. The byte offset lets a reconnect replay exactly the events it missed.

use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::debug;

use crate::ssh::exec::sh_quote;
use crate::ssh::{SshConnection, SshError};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HookEvent {
    #[serde(default)]
    pub ts: u64,
    /// tmux pane id, e.g. `%12`.
    pub pane: String,
    #[serde(default)]
    pub harness: String,
    pub event: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub transcript: String,
}

#[derive(Debug)]
pub enum TailMsg {
    /// Where the tail started (bytes into the file).
    Started { offset: u64 },
    Event { event: HookEvent, end_offset: u64 },
    Closed,
}

/// Rotate the log once it's fully consumed and bigger than this.
const ROTATE_BYTES: u64 = 2_000_000;

fn script(offset: Option<u64>) -> String {
    let start = offset.map_or_else(|| "$size".to_string(), |o| o.to_string());
    format!(
        r#"f="${{XDG_STATE_HOME:-$HOME/.local/state}}/consuls/events.jsonl"
mkdir -p "$(dirname "$f")" && touch "$f"
size=$(wc -c < "$f" | tr -d ' ')
start={start}
[ "$start" -gt "$size" ] && start=$size
if [ "$size" -gt {ROTATE_BYTES} ] && [ "$start" -ge "$size" ]; then : > "$f"; size=0; start=0; fi
printf 'CHM-OFFSET %s\n' "$start"
exec tail -c +$((start + 1)) -F "$f" 2>/dev/null"#
    )
}

/// Starts tailing; messages arrive on the returned channel until the SSH channel closes.
pub async fn start(conn: &SshConnection, offset: Option<u64>) -> Result<mpsc::UnboundedReceiver<TailMsg>, SshError> {
    let channel = conn.open_exec(&format!("exec sh -c {}", sh_quote(&script(offset)))).await?;
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let (mut read, _write) = channel.split();
        let mut buf: Vec<u8> = Vec::new();
        let mut offset: Option<u64> = None;
        while let Some(msg) = read.wait().await {
            let russh::ChannelMsg::Data { data } = msg else {
                if matches!(msg, russh::ChannelMsg::Eof | russh::ChannelMsg::Close) {
                    break;
                }
                continue;
            };
            buf.extend_from_slice(&data);
            while let Some(nl) = memchr::memchr(b'\n', &buf) {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                match offset {
                    None => {
                        if let Some(n) = text.strip_prefix("CHM-OFFSET ").and_then(|n| n.trim().parse().ok()) {
                            offset = Some(n);
                            let _ = tx.send(TailMsg::Started { offset: n });
                        }
                    }
                    Some(ref mut off) => {
                        *off += line.len() as u64;
                        match serde_json::from_str::<HookEvent>(&text) {
                            Ok(event) => {
                                let _ = tx.send(TailMsg::Event { event, end_offset: *off });
                            }
                            Err(e) => debug!("ignoring malformed event line ({e}): {text}"),
                        }
                    }
                }
            }
        }
        let _ = tx.send(TailMsg::Closed);
    });
    Ok(rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hook_lines() {
        let line = r#"{"v":1,"ts":1790553770,"pane":"%2","harness":"claude","event":"SessionStart","detail":"","session":"2b09","transcript":"/x.jsonl"}"#;
        let e: HookEvent = serde_json::from_str(line).unwrap();
        assert_eq!((e.pane.as_str(), e.event.as_str(), e.ts), ("%2", "SessionStart", 1790553770));
    }

    #[test]
    fn script_uses_offset() {
        assert!(script(Some(42)).contains("start=42"));
        assert!(script(None).contains("start=$size"));
    }
}
