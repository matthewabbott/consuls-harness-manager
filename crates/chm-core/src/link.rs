//! Where a tmux server is reached: over SSH, or on this machine through a local POSIX shell
//! (Cygwin's bash on Windows, `/bin/sh` elsewhere). The tmux manager only needs two things —
//! run a script, and open a long-lived command it talks to (a control client) — so that's all
//! a link offers.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc};

use crate::ssh::exec::{self, ExecOutput, login_shell, sh_quote};
use crate::ssh::{SshConnection, SshError};

#[derive(Clone)]
pub enum Link {
    Ssh(Arc<SshConnection>),
    Local(Arc<LocalSh>),
}

/// A running command's output, as it arrives. The channel closes when the command ends.
pub enum StreamMsg {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
}

/// A running command: its output, and its stdin.
pub struct Stream {
    pub output: mpsc::UnboundedReceiver<StreamMsg>,
    pub input: StreamInput,
}

pub enum StreamInput {
    Ssh(russh::ChannelWriteHalf<russh::client::Msg>),
    Local(Arc<Mutex<tokio::process::ChildStdin>>),
}

impl StreamInput {
    pub async fn write(&self, bytes: Vec<u8>) -> Result<(), SshError> {
        match self {
            StreamInput::Ssh(w) => w.data_bytes(bytes::Bytes::from(bytes)).await.map_err(SshError::from),
            StreamInput::Local(stdin) => {
                let mut stdin = stdin.lock().await;
                stdin.write_all(&bytes).await.map_err(|e| SshError::Other(e.to_string()))?;
                stdin.flush().await.map_err(|e| SshError::Other(e.to_string()))
            }
        }
    }
}

impl Link {
    /// Runs `script` (POSIX sh) in a login shell and collects its output and exit status.
    pub async fn exec(&self, script: &str, timeout: Duration) -> Result<ExecOutput, SshError> {
        match self {
            Link::Ssh(conn) => exec::run(conn, script, timeout).await,
            Link::Local(sh) => sh.exec(script, timeout).await,
        }
    }

    /// The command line that runs a tmux control client (`script` is `exec tmux … -C …`).
    pub fn control_command(&self, script: &str) -> String {
        match self {
            Link::Local(sh) if sh.control_needs_pty => {
                // Cygwin's tmux server can't use a pipe as a control client's terminal (the
                // replies never arrive); a pty from script(1), raw and without echo, works.
                let inner = format!("stty raw -echo; {script}");
                login_shell(&format!("exec script -qfec {} /dev/null", sh_quote(&inner)))
            }
            _ => login_shell(script),
        }
    }

    /// Starts `command` (a shell command line, as an SSH exec would run it).
    pub async fn open(&self, command: &str) -> Result<Stream, SshError> {
        match self {
            Link::Ssh(conn) => {
                let channel = conn.open_exec(command).await?;
                let (mut read, write) = channel.split();
                let (tx, rx) = mpsc::unbounded_channel();
                // Drain promptly: a stalled channel would block the whole SSH connection.
                tokio::spawn(async move {
                    while let Some(msg) = read.wait().await {
                        let sent = match msg {
                            ChannelMsg::Data { data } => tx.send(StreamMsg::Stdout(data.to_vec())),
                            ChannelMsg::ExtendedData { data, .. } => tx.send(StreamMsg::Stderr(data.to_vec())),
                            ChannelMsg::Eof | ChannelMsg::Close => break,
                            _ => Ok(()),
                        };
                        if sent.is_err() {
                            break;
                        }
                    }
                });
                Ok(Stream { output: rx, input: StreamInput::Ssh(write) })
            }
            Link::Local(sh) => sh.open(command),
        }
    }
}

/// A POSIX shell on this machine. On Windows that's Cygwin's `bash.exe`: scripts reach it
/// base64-encoded, so Windows command-line quoting (and Cygwin's globbing of it) can't touch them.
pub struct LocalSh {
    pub sh: PathBuf,
    /// Added to (or, with an empty value, removed from) this process's environment.
    pub env: Vec<(String, String)>,
    /// Wrap control clients in script(1) (Cygwin).
    pub control_needs_pty: bool,
}

/// Runs the base64-encoded command in `$1`. Absolute: before a login profile runs, PATH is just
/// Windows' own.
const BOOT: &str = r#"eval "$(printf %s "$1" | /usr/bin/base64 -d)""#;

impl LocalSh {
    fn command(&self, command: &str) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.sh);
        if cfg!(windows) {
            use base64::Engine;
            cmd.args(["-c", BOOT, "chm", &base64::engine::general_purpose::STANDARD.encode(command)]);
        } else {
            cmd.args(["-c", command]);
        }
        // Nothing of the app's own (or of a tmux/Consuls pane it may run in) leaks into a tmux
        // server started from here.
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy();
            if k.starts_with("WEBVIEW2_") || k.starts_with("CHM_") || k == "TMUX" || k == "TMUX_PANE" {
                cmd.env_remove(k.as_ref());
            }
        }
        for (k, v) in &self.env {
            if v.is_empty() {
                cmd.env_remove(k);
            } else {
                cmd.env(k, v);
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        cmd
    }

    async fn exec(&self, script: &str, timeout: Duration) -> Result<ExecOutput, SshError> {
        let mut child = self.command(&exec::command_for(script)).spawn().map_err(|e| SshError::Other(format!("{}: {e}", self.sh.display())))?;
        drop(child.stdin.take());
        let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let collect = async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            a.and(b).map_err(|e| SshError::Other(e.to_string()))?;
            let status = child.wait().await.map_err(|e| SshError::Other(e.to_string()))?;
            Ok::<_, SshError>((out, err, status.code()))
        };
        let (out, err, code) = tokio::time::timeout(timeout, collect).await.map_err(|_| SshError::Timeout(format!("local command: {script}")))??;
        let mut result = exec::finish(out, err);
        if result.status.is_none() {
            result.status = code.map(|c| c as u32);
        }
        Ok(result)
    }

    fn open(&self, command: &str) -> Result<Stream, SshError> {
        let mut child = self.command(command).spawn().map_err(|e| SshError::Other(format!("{}: {e}", self.sh.display())))?;
        #[cfg(windows)]
        end_with_this_app(&child);
        let stdin = child.stdin.take().unwrap();
        let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let (tx, rx) = mpsc::unbounded_channel();
        let err_tx = tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            while let Ok(n @ 1..) = stderr.read(&mut buf).await {
                if err_tx.send(StreamMsg::Stderr(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            while let Ok(n @ 1..) = stdout.read(&mut buf).await {
                if tx.send(StreamMsg::Stdout(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
            // Ended (or nobody listens): make sure the process goes too.
            let _ = child.kill().await;
        });
        Ok(Stream { output: rx, input: StreamInput::Local(Arc::new(Mutex::new(stdin))) })
    }
}

/// Puts a long-lived helper (a control client) in a job that Windows kills when this app exits,
/// however it exits. Without it a Cygwin control client (script(1) in raw mode) never notices
/// its reader is gone. Scripts aren't in it: one may start the tmux server, which must outlive us.
#[cfg(windows)]
fn end_with_this_app(child: &tokio::process::Child) {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    // The handle is never closed: it closes when the process ends, which is the point.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls; `info` lives across the call.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const info).cast(), size_of_val(&info) as u32);
            job as usize
        }
    });
    if let (true, Some(process)) = (job != 0, child.raw_handle()) {
        // SAFETY: both handles are valid; failure just leaves the process outside the job.
        unsafe { AssignProcessToJobObject(job as _, process as _) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Git for Windows' sh stands in for Cygwin's bash (same POSIX contract); elsewhere /bin/sh.
    fn local() -> Option<Link> {
        let sh = ["/bin/sh", "D:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.exists())?;
        let shell = if cfg!(windows) { "/usr/bin/sh" } else { "/bin/sh" };
        Some(Link::Local(Arc::new(LocalSh { sh, env: vec![("SHELL".into(), shell.into())], control_needs_pty: false })))
    }

    #[tokio::test]
    async fn local_exec_reports_output_and_status() {
        let Some(link) = local() else { return };
        let out = link.exec("printf 'a b\\n'; echo \"it's $((6*7))\" >&2; exit 3", Duration::from_secs(20)).await.unwrap();
        assert_eq!(out.stdout_str(), "a b\n");
        assert_eq!(out.stderr_str().trim(), "it's 42");
        assert_eq!(out.status, Some(3));
        // Quoting survives (Windows command-line rules never see the script).
        let out = link.exec("printf '%s|' \"a  b\" '*' \"\\\"q\\\"\"", Duration::from_secs(20)).await.unwrap();
        assert_eq!(out.stdout_str(), "a  b|*|\"q\"|");
    }

    #[tokio::test]
    async fn local_stream_round_trip() {
        let Some(link) = local() else { return };
        let mut s = link.open(&login_shell("exec cat")).await.unwrap();
        s.input.write(b"hello\n".to_vec()).await.unwrap();
        let mut got = Vec::new();
        while !got.ends_with(b"hello\n") {
            match tokio::time::timeout(Duration::from_secs(10), s.output.recv()).await.unwrap() {
                Some(StreamMsg::Stdout(b)) => got.extend(b),
                Some(StreamMsg::Stderr(_)) => {}
                None => panic!("closed early"),
            }
        }
        drop(s.input); // EOF: cat exits, the stream ends
        while let Ok(Some(_)) = tokio::time::timeout(Duration::from_secs(10), s.output.recv()).await {}
    }
}
