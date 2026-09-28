//! Interactive sessions on a PTY we own: an SSH `pty-req` channel, or a local pseudo-console
//! (ConPTY on Windows). Both look the same to the rest of the core: bytes and resizes in,
//! bytes and one exit notice out.

use std::io::{Read, Write};

use russh::ChannelMsg;
use tokio::sync::mpsc;
use tracing::debug;

use crate::ssh::{Channel, SshConnection, SshError};

#[derive(Debug)]
pub enum PtyInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    /// Hang up: end the session (the process gets SIGHUP / its console closes).
    Close,
}

#[derive(Debug)]
pub enum PtyOutput {
    Data(Vec<u8>),
    /// The session is over (output may still trail in). Human-readable reason.
    Exited(String),
}

pub struct Pty {
    pub input: mpsc::UnboundedSender<PtyInput>,
    pub output: mpsc::UnboundedReceiver<PtyOutput>,
}

/// Runs `command` on the host with a PTY of `cols`×`rows`.
pub async fn ssh(conn: &SshConnection, command: &str, cols: u16, rows: u16) -> Result<Pty, SshError> {
    let channel = conn.open_pty(command, cols, rows).await?;
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    tokio::spawn(ssh_pump(channel, in_rx, out_tx));
    Ok(Pty { input: in_tx, output: out_rx })
}

async fn ssh_pump(channel: Channel, mut input: mpsc::UnboundedReceiver<PtyInput>, output: mpsc::UnboundedSender<PtyOutput>) {
    let (mut read, write) = channel.split();
    let mut status: Option<String> = None;
    loop {
        tokio::select! {
            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    let _ = output.send(PtyOutput::Data(data.to_vec()));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let _ = output.send(PtyOutput::Data(data.to_vec()));
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    status = Some(if exit_status == 0 { "The shell exited".into() } else { format!("The shell exited with status {exit_status}") });
                }
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    status = Some(format!("The shell was killed ({signal_name:?})"));
                }
                Some(_) => {}
                None => break,
            },
            cmd = input.recv() => match cmd {
                Some(PtyInput::Data(bytes)) => {
                    if let Err(e) = write.data_bytes(bytes).await {
                        debug!("pty write failed: {e}");
                    }
                }
                Some(PtyInput::Resize { cols, rows }) => {
                    let _ = write.window_change(cols as u32, rows as u32, 0, 0).await;
                }
                Some(PtyInput::Close) | None => {
                    let _ = write.close().await;
                    status.get_or_insert_with(|| "Closed".into());
                    break;
                }
            },
        }
    }
    let _ = output.send(PtyOutput::Exited(status.unwrap_or_else(|| "Connection lost".into())));
}

/// A local program to run as a shell (see [`crate::local::shells`]).
#[derive(Debug, Clone)]
pub struct LocalCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

/// Starts `cmd` on a local pseudo-terminal.
pub fn local(cmd: &LocalCommand, cols: u16, rows: u16) -> Result<Pty, String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    // Native separators on Windows: cmd.exe reads `C:/WINDOWS/…` in its own command line as
    // `/W…` switches.
    let native = |p: &str| if cfg!(windows) { p.replace('/', "\\") } else { p.to_string() };
    let size = |cols: u16, rows: u16| PtySize { cols: cols.max(1), rows: rows.max(1), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| format!("couldn't open a pseudo-terminal: {e}"))?;
    let mut builder = CommandBuilder::new(native(&cmd.program));
    builder.args(&cmd.args);
    if let Some(cwd) = cmd.cwd.as_deref().filter(|c| std::path::Path::new(c).is_dir()) {
        builder.cwd(native(cwd));
    }
    for (k, v) in &cmd.env {
        builder.env(k, v);
    }
    let mut child = pair.slave.spawn_command(builder).map_err(|e| format!("couldn't start {}: {e}", cmd.program))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;
    let mut killer = child.clone_killer();

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<PtyInput>();
    let (out_tx, out_rx) = mpsc::unbounded_channel();

    let data_tx = out_tx.clone();
    std::thread::Builder::new()
        .name("chm-pty-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if data_tx.send(PtyOutput::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    // When the process exits, close the pseudo-console too: on Windows the output pipe
    // otherwise stays open and the reader never sees EOF.
    let close_tx = in_tx.clone();
    std::thread::Builder::new()
        .name("chm-pty-wait".into())
        .spawn(move || {
            let reason = match child.wait() {
                Ok(status) if status.success() => "The shell exited".to_string(),
                Ok(status) => format!("The shell exited with status {}", status.exit_code()),
                Err(e) => format!("The shell went away ({e})"),
            };
            let _ = out_tx.send(PtyOutput::Exited(reason));
            let _ = close_tx.send(PtyInput::Close);
        })
        .map_err(|e| e.to_string())?;

    std::thread::Builder::new()
        .name("chm-pty-write".into())
        .spawn(move || {
            while let Some(msg) = in_rx.blocking_recv() {
                match msg {
                    PtyInput::Data(bytes) => {
                        if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                            break;
                        }
                    }
                    PtyInput::Resize { cols, rows } => {
                        let _ = master.resize(size(cols, rows));
                    }
                    PtyInput::Close => {
                        let _ = killer.kill();
                        break;
                    }
                }
            }
            drop(writer);
            drop(master);
        })
        .map_err(|e| e.to_string())?;

    Ok(Pty { input: in_tx, output: out_rx })
}
