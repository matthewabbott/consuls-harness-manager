//! One-off remote commands, run through the user's login shell so PATH matches what they
//! see interactively (Homebrew, ~/.local/bin, nvm, …).

use std::time::Duration;

use russh::ChannelMsg;

use super::{SshConnection, SshError};

/// Quotes `s` as a single POSIX-shell word.
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Wraps `script` so the remote runs it in a login shell. `$SHELL` (not `${SHELL:-…}`) keeps
/// the outer command valid for fish users too.
pub fn login_shell(script: &str) -> String {
    format!("exec $SHELL -lc {}", sh_quote(script))
}

/// Marker printed before the real output so login-shell noise (motd, conda, …) is dropped.
const MARKER: &str = "__CHM_OUTPUT_BEGINS__";

#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    pub status: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOutput {
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_str(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }
}

fn strip_before_marker(stdout: &[u8]) -> Vec<u8> {
    let needle = format!("{MARKER}\n");
    match memchr::memmem::find(stdout, needle.as_bytes()) {
        Some(pos) => stdout[pos + needle.len()..].to_vec(),
        None => stdout.to_vec(),
    }
}

/// Runs `script` in a login shell and collects its output.
pub async fn run(conn: &SshConnection, script: &str, timeout: Duration) -> Result<ExecOutput, SshError> {
    run_with_stdin(conn, script, None, timeout).await
}

/// Like [`run`], but writes `stdin` to the command and closes it.
pub async fn run_with_stdin(
    conn: &SshConnection,
    script: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecOutput, SshError> {
    let full = format!("printf '%s\\n' {MARKER}; {script}");
    let mut channel = conn.open_exec(&login_shell(&full)).await?;
    if let Some(data) = stdin {
        channel.data_bytes(bytes::Bytes::copy_from_slice(data)).await?;
    }
    channel.eof().await?;

    let collect = async {
        let mut out = ExecOutput::default();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => out.status = Some(exit_status),
                _ => {}
            }
        }
        out
    };
    let mut out = tokio::time::timeout(timeout, collect)
        .await
        .map_err(|_| SshError::Timeout(format!("remote command: {script}")))?;
    out.stdout = strip_before_marker(&out.stdout);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(login_shell("echo 'hi'"), "exec $SHELL -lc 'echo '\\''hi'\\'''");
    }

    #[test]
    fn strips_login_noise() {
        let raw = b"Welcome to Ubuntu\n(base) conda\n__CHM_OUTPUT_BEGINS__\nreal\n";
        assert_eq!(strip_before_marker(raw), b"real\n");
        assert_eq!(strip_before_marker(b"no marker"), b"no marker");
    }
}
