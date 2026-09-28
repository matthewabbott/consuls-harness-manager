//! A tmux control-mode client, over an SSH exec channel or a local process (see `link`).
//!
//! Replies are matched to commands in FIFO order (tmux answers a client's commands in the
//! order they were sent). Replies can be delivered either to the caller (oneshot) or
//! *in-band* on the event stream as [`ClientEvent::Tagged`], which keeps them ordered
//! relative to pane output — that's what makes race-free pane seeding possible.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::{Mutex, mpsc, oneshot};
use tracing::{debug, warn};

use super::parser::{Event, Parser, Reply};
use crate::link::{Link, Stream, StreamInput, StreamMsg};
use crate::ssh::SshError;
use crate::ssh::exec::sh_quote;

#[derive(thiserror::Error, Debug, Clone)]
pub enum TmuxError {
    #[error("tmux control client closed{}", .0.as_ref().map(|r| format!(": {r}")).unwrap_or_default())]
    Closed(Option<String>),
    #[error("tmux command failed: {0}")]
    Command(String),
    #[error("timed out waiting for tmux")]
    Timeout,
    #[error("ssh: {0}")]
    Ssh(String),
}

impl From<SshError> for TmuxError {
    fn from(e: SshError) -> Self {
        TmuxError::Ssh(e.to_string())
    }
}

/// Identifies a control client within one host (we attach one per session group).
pub type ClientKey = u32;

#[derive(Debug)]
pub enum ClientEvent {
    Tmux(Event),
    /// Replies to a command sent with [`ControlClient::send_tagged`], in stream order.
    Tagged { tag: u64, replies: Vec<Reply> },
    Closed { reason: Option<String> },
}

enum Delivery {
    Oneshot(oneshot::Sender<Result<Vec<Reply>, TmuxError>>),
    Stream(u64),
}

struct Pending {
    expected: usize,
    got: Vec<Reply>,
    delivery: Delivery,
}

struct Shared {
    key: ClientKey,
    pending: StdMutex<VecDeque<Pending>>,
    closed: AtomicBool,
    events: mpsc::UnboundedSender<(ClientKey, ClientEvent)>,
}

impl Shared {
    fn fail_all(&self, reason: &Option<String>) {
        let drained: Vec<Pending> = self.pending.lock().unwrap().drain(..).collect();
        for p in drained {
            if let Delivery::Oneshot(tx) = p.delivery {
                let _ = tx.send(Err(TmuxError::Closed(reason.clone())));
            }
        }
    }

    fn on_reply(&self, reply: Reply) {
        if !reply.from_this_client() {
            // e.g. the implicit `attach-session` reply, or commands run by hooks.
            debug!(client = self.key, "unsolicited reply #{}", reply.number);
            return;
        }
        let done = {
            let mut pending = self.pending.lock().unwrap();
            let Some(front) = pending.front_mut() else {
                warn!(client = self.key, "reply #{} with no pending command", reply.number);
                return;
            };
            // tmux stops executing a command line at the first error (and a parse error
            // yields a single %error for the whole line), so an error completes the entry.
            let failed = !reply.ok;
            front.got.push(reply);
            if failed || front.got.len() >= front.expected { pending.pop_front() } else { None }
        };
        if let Some(p) = done {
            match p.delivery {
                Delivery::Oneshot(tx) => {
                    let _ = tx.send(Ok(p.got));
                }
                Delivery::Stream(tag) => {
                    let _ = self.events.send((self.key, ClientEvent::Tagged { tag, replies: p.got }));
                }
            }
        }
    }
}

pub struct ControlClient {
    shared: Arc<Shared>,
    writer: Mutex<StreamInput>,
    /// The session this client is attached to, e.g. `$3`.
    pub session_id: String,
}

/// How to reach the tmux server.
#[derive(Debug, Clone, Default)]
pub struct TmuxServer {
    /// `-L <name>` socket; `None` for the default server.
    pub socket_name: Option<String>,
    /// Absolute path of the tmux binary when it isn't on the login shell's PATH (e.g. a
    /// Homebrew in the home folder that only `~/.zshrc` adds); `None` runs plain `tmux`.
    pub bin: Option<String>,
}

impl TmuxServer {
    pub fn prefix(&self) -> String {
        let bin = self.bin.as_deref().map_or_else(|| "tmux".to_string(), sh_quote);
        match &self.socket_name {
            Some(name) => format!("{bin} -L {}", sh_quote(name)),
            None => bin,
        }
    }
}

impl ControlClient {
    /// Attaches a control client to `session` (an id like `$3` or `=name`) without
    /// affecting the size of the user's other clients.
    pub async fn attach(
        link: &Link,
        server: &TmuxServer,
        session: &str,
        key: ClientKey,
        events: mpsc::UnboundedSender<(ClientKey, ClientEvent)>,
    ) -> Result<Self, TmuxError> {
        let script = format!(
            "exec {} -u -C attach-session -t {} -f ignore-size,pause-after=5",
            server.prefix(),
            sh_quote(session)
        );
        Self::start(link, &link.control_command(&script), key, events).await
    }

    /// Starts `command` (which must run `tmux -C …`) over `link`.
    pub async fn start(
        link: &Link,
        command: &str,
        key: ClientKey,
        events: mpsc::UnboundedSender<(ClientKey, ClientEvent)>,
    ) -> Result<Self, TmuxError> {
        let Stream { output: mut read, input: write } = link.open(command).await?;
        let shared = Arc::new(Shared {
            key,
            pending: StdMutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
            events,
        });

        let reader_shared = shared.clone();
        tokio::spawn(async move {
            let shared = reader_shared;
            let mut parser = Parser::new();
            let mut stderr = Vec::new();
            while let Some(msg) = read.recv().await {
                match msg {
                    StreamMsg::Stdout(data) => {
                        for ev in parser.feed(&data) {
                            match ev {
                                Event::Reply(reply) => shared.on_reply(reply),
                                Event::Noise(line) => debug!(client = shared.key, "noise: {}", String::from_utf8_lossy(&line)),
                                other => {
                                    let _ = shared.events.send((shared.key, ClientEvent::Tmux(other)));
                                }
                            }
                        }
                    }
                    StreamMsg::Stderr(data) => stderr.extend_from_slice(&data),
                }
            }
            let reason = Some(String::from_utf8_lossy(&stderr).trim().to_string()).filter(|s| !s.is_empty());
            shared.closed.store(true, Ordering::SeqCst);
            shared.fail_all(&reason);
            let _ = shared.events.send((shared.key, ClientEvent::Closed { reason }));
        });

        let client = Self { shared, writer: Mutex::new(write), session_id: String::new() };
        // Confirm the attach worked (fails fast if the session doesn't exist).
        let reply = tokio::time::timeout(Duration::from_secs(20), client.command("display-message -p '#{session_id}'"))
            .await
            .map_err(|_| TmuxError::Timeout)??;
        Ok(Self { session_id: reply.text().trim().to_string(), ..client })
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    async fn write(&self, line: &str, expected: usize, delivery: Delivery) -> Result<(), TmuxError> {
        debug_assert!(!line.is_empty() && !line.contains('\n'), "control-mode lines must be non-empty and single-line");
        if line.is_empty() || line.contains('\n') {
            return Err(TmuxError::Command("refusing to send an empty or multi-line command".into()));
        }
        if self.is_closed() {
            return Err(TmuxError::Closed(None));
        }
        let writer = self.writer.lock().await;
        self.shared.pending.lock().unwrap().push_back(Pending { expected, got: Vec::new(), delivery });
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        writer.write(bytes).await.map_err(|e| TmuxError::Ssh(e.to_string()))
    }

    /// Sends a line containing `count` commands separated by ` ; ` and waits for all replies.
    pub async fn commands(&self, line: &str, count: usize) -> Result<Vec<Reply>, TmuxError> {
        let (tx, rx) = oneshot::channel();
        self.write(line, count, Delivery::Oneshot(tx)).await?;
        rx.await.map_err(|_| TmuxError::Closed(None))?
    }

    /// Sends one command and returns its reply; `%error` becomes [`TmuxError::Command`].
    pub async fn command(&self, line: &str) -> Result<Reply, TmuxError> {
        let reply = self.commands(line, 1).await?.remove(0);
        if reply.ok { Ok(reply) } else { Err(TmuxError::Command(reply.text())) }
    }

    /// Sends commands whose replies are delivered in-band as [`ClientEvent::Tagged`].
    pub async fn send_tagged(&self, line: &str, count: usize, tag: u64) -> Result<(), TmuxError> {
        self.write(line, count, Delivery::Stream(tag)).await
    }

    pub async fn detach(&self) {
        let _ = self.commands("detach-client", 1).await;
    }
}
