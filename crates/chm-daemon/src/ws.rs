//! The web app's live connection (`/api/ws`): the core's events and pane frames out, its calls
//! in (`rpc.rs`).
//!
//! One client at a time. The core has one set of streamed panes and one focus (what the user is
//! looking at, which decides what counts as seen), so a new connection takes over and the old
//! one is told ("in use on another device"). When a client goes, its focus goes with it: a dead
//! phone "looking at" a pane would otherwise keep that pane's pushes from ever being sent.
//!
//! Server → client, text: `{"type":"hello",…}`, `{"type":"reply","id",…"ok"|"error"}`,
//! `{"type":"event","event"}`, `{"type":"resync"}` (events were missed: fetch the snapshot again),
//! `{"type":"takenOver"}`. Binary: pane frames, batched (`ipc/frames.ts`).
//! Client → server: `{"id","method","params"}`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use chm_core::model::{CoreEvent, FocusState};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::Instant;
use tracing::{debug, info};

use crate::{Daemon, rpc};

/// Frames waiting for a slow client: past this, they're dropped and the open panes re-sent whole.
const FRAME_CAP: usize = 32 << 20;
const FLUSH: Duration = Duration::from_millis(33);
const PING: Duration = Duration::from_secs(15);
/// Two pings without an answer.
const DEAD: Duration = Duration::from_secs(35);

pub struct Clients {
    events: broadcast::Sender<Arc<str>>,
    active: Mutex<Option<Active>>,
    next: AtomicU64,
}

struct Active {
    id: u64,
    frames: Vec<u8>,
    overflow: bool,
    kick: Option<oneshot::Sender<()>>,
}

impl Clients {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { events: broadcast::channel(1024).0, active: Mutex::new(None), next: AtomicU64::new(1) })
    }

    /// A core event for the client (serialized once).
    pub fn event(&self, event: &CoreEvent) {
        if self.events.receiver_count() == 0 {
            return;
        }
        if let Ok(json) = serde_json::to_string(event) {
            let _ = self.events.send(format!(r#"{{"type":"event","event":{json}}}"#).into());
        }
    }

    /// Pane frames for the client, sent with the next flush.
    pub fn frame(&self, bytes: Vec<u8>) {
        let mut active = self.active.lock().unwrap();
        let Some(a) = active.as_mut() else { return };
        if a.frames.len() + bytes.len() > FRAME_CAP {
            a.frames.clear();
            a.overflow = true;
        } else {
            a.frames.extend_from_slice(&bytes);
        }
    }

    fn take_over(&self) -> (u64, oneshot::Receiver<()>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (kick, kicked) = oneshot::channel();
        let mut active = self.active.lock().unwrap();
        if let Some(old) = active.as_mut().and_then(|a| a.kick.take()) {
            let _ = old.send(());
        }
        *active = Some(Active { id, frames: Vec::new(), overflow: false, kick: Some(kick) });
        (id, kicked)
    }

    /// The frames gathered for `id` (and whether some were dropped), or None once it isn't the
    /// client any more.
    fn take_frames(&self, id: u64) -> Option<(Vec<u8>, bool)> {
        let mut active = self.active.lock().unwrap();
        let a = active.as_mut().filter(|a| a.id == id)?;
        Some((std::mem::take(&mut a.frames), std::mem::replace(&mut a.overflow, false)))
    }

    /// `id` is done; true if it was still the client.
    fn leave(&self, id: u64) -> bool {
        let mut active = self.active.lock().unwrap();
        if active.as_ref().is_some_and(|a| a.id == id) {
            *active = None;
            return true;
        }
        false
    }
}

#[derive(Deserialize)]
struct Call {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

fn reply(id: u64, result: Result<Value, Value>) -> String {
    match result {
        Ok(v) => json!({ "type": "reply", "id": id, "ok": v }).to_string(),
        Err(e) => json!({ "type": "reply", "id": id, "error": e }).to_string(),
    }
}

/// Serves one client until it goes, is taken over, or stops answering.
pub async fn serve(socket: WebSocket, d: Arc<Daemon>) {
    let (id, mut kicked) = d.clients.take_over();
    info!("phone connected (client {id})");
    let mut events = d.clients.events.subscribe();
    let (mut out, mut incoming) = socket.split();
    let hello = json!({
        "type": "hello",
        "instance": d.instance,
        "selfName": d.self_name,
        "version": env!("CARGO_PKG_VERSION"),
    });
    if out.send(Message::Text(hello.to_string().into())).await.is_err() {
        d.clients.leave(id);
        return;
    }
    d.lease.renew(None);
    d.human_here();

    // What it streams, to send whole again if its frames overflow, and to stop when it goes.
    let streams: Arc<Mutex<HashSet<u32>>> = Arc::default();
    let last_heard = Arc::new(Mutex::new(Instant::now()));
    let (replies_tx, mut replies) = mpsc::unbounded_channel::<String>();

    let reader = {
        let (d, streams, last_heard, replies_tx) = (d.clone(), streams.clone(), last_heard.clone(), replies_tx.clone());
        tokio::spawn(async move {
            let mut checked_in = Instant::now();
            while let Some(Ok(msg)) = incoming.next().await {
                *last_heard.lock().unwrap() = Instant::now();
                let Message::Text(text) = msg else {
                    if matches!(msg, Message::Close(_)) {
                        break;
                    }
                    continue;
                };
                // Using the app is a check-in (at most once a minute).
                if checked_in.elapsed() > Duration::from_secs(60) {
                    checked_in = Instant::now();
                    d.lease.renew(None);
                    d.human_here();
                }
                let call: Call = match serde_json::from_str(&text) {
                    Ok(c) => c,
                    Err(e) => {
                        debug!("bad call from the web app: {e}");
                        continue;
                    }
                };
                if call.method == "stream_pane"
                    && let (Some(key), Some(on)) = (call.params["key"].as_u64(), call.params["on"].as_bool())
                {
                    let mut s = streams.lock().unwrap();
                    if on { s.insert(key as u32) } else { s.remove(&(key as u32)) };
                }
                if rpc::is_slow(&call.method) {
                    let (d, tx) = (d.clone(), replies_tx.clone());
                    tokio::spawn(async move {
                        let _ = tx.send(reply(call.id, rpc::call(&d, &call.method, call.params).await));
                    });
                } else {
                    // In order: typing must arrive as typed.
                    let _ = replies_tx.send(reply(call.id, rpc::call(&d, &call.method, call.params).await));
                }
            }
        })
    };
    drop(replies_tx);

    let mut flush = tokio::time::interval(FLUSH);
    let mut ping = tokio::time::interval(PING);
    let why = loop {
        let sent = tokio::select! {
            _ = &mut kicked => {
                let _ = out.send(Message::Text(json!({ "type": "takenOver" }).to_string().into())).await;
                break "taken over by another device";
            }
            r = replies.recv() => match r {
                Some(text) => out.send(Message::Text(text.into())).await,
                None => break "it went away",
            },
            e = events.recv() => match e {
                Ok(text) => out.send(Message::Text(text.to_string().into())).await,
                Err(broadcast::error::RecvError::Lagged(_)) => out.send(Message::Text(json!({ "type": "resync" }).to_string().into())).await,
                Err(broadcast::error::RecvError::Closed) => break "the server is stopping",
            },
            _ = flush.tick() => {
                let Some((frames, overflow)) = d.clients.take_frames(id) else { break "taken over" };
                if overflow {
                    // It fell behind: the open panes start over from a fresh copy.
                    for &key in streams.lock().unwrap().iter() {
                        d.core.stream_pane(key, true);
                    }
                }
                if frames.is_empty() { continue }
                out.send(Message::Binary(frames.into())).await
            }
            _ = ping.tick() => {
                if last_heard.lock().unwrap().elapsed() > DEAD {
                    break "it stopped answering";
                }
                out.send(Message::Ping(Vec::new().into())).await
            }
        };
        if sent.is_err() {
            break "the connection broke";
        }
    };
    reader.abort();
    let _ = out.close().await;
    info!("phone disconnected (client {id}): {why}");
    if d.clients.leave(id) {
        d.core.set_focus(FocusState { expanded: None, window_focused: false });
        for key in streams.lock().unwrap().drain() {
            d.core.stream_pane(key, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_client_at_a_time() {
        let c = Clients::new();
        let (a, mut kicked_a) = c.take_over();
        c.frame(vec![1, 2, 3]);
        assert_eq!(c.take_frames(a), Some((vec![1, 2, 3], false)));
        let (b, _kicked_b) = c.take_over();
        assert!(kicked_a.try_recv().is_ok(), "the first one is told");
        assert_eq!(c.take_frames(a), None, "and gets nothing more");
        c.frame(vec![0; FRAME_CAP + 1]);
        assert_eq!(c.take_frames(b), Some((Vec::new(), true)), "too much: dropped, and said so");
        assert!(!c.leave(a), "the old one leaving doesn't touch the new one");
        assert!(c.leave(b));
    }
}
