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
/// Marker before the script's exit status, printed after its output. SSH's own exit status
/// can't be trusted: Tailscale SSH on macOS runs commands through `/usr/bin/login`, which
/// always exits 0.
const STATUS: &str = "__CHM_EXIT_STATUS__";

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

/// Splits the script's reported exit status off the end of its output (the output itself is
/// returned byte-exact).
fn take_status(stdout: &mut Vec<u8>) -> Option<u32> {
    let needle = format!("\n{STATUS}");
    let pos = memchr::memmem::rfind(stdout, needle.as_bytes())?;
    let status = std::str::from_utf8(&stdout[pos + needle.len()..]).ok()?.trim().parse().ok()?;
    stdout.truncate(pos);
    Some(status)
}

/// The command line for `script`: the login shell (for the user's PATH) execs `sh`, so scripts
/// are POSIX whatever the user's shell is, and `sh` reports the script's own exit status.
pub(crate) fn command_for(script: &str) -> String {
    let inner = format!("printf '%s\\n' {MARKER}; (\n{script}\n); s=$?; printf '\\n{STATUS}%s\\n' \"$s\"; exit $s");
    login_shell(&format!("exec sh -c {}", sh_quote(&inner)))
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
    let mut channel = conn.open_exec(&command_for(script)).await?;
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
    let out = tokio::time::timeout(timeout, collect)
        .await
        .map_err(|_| SshError::Timeout(format!("remote command: {script}")))?;
    let mut done = finish(out.stdout, out.stderr);
    done.status = done.status.or(out.status);
    Ok(done)
}

/// The output of a [`command_for`] command: login-shell noise dropped, and the script's own
/// exit status (when it got to report it) split off.
pub(crate) fn finish(stdout: Vec<u8>, stderr: Vec<u8>) -> ExecOutput {
    let mut stdout = strip_before_marker(&stdout);
    let status = take_status(&mut stdout);
    ExecOutput { status, stdout, stderr }
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
    fn exit_status_comes_from_the_script() {
        let mut out = b"content without newline\n__CHM_EXIT_STATUS__5\n".to_vec();
        assert_eq!(take_status(&mut out), Some(5));
        assert_eq!(out, b"content without newline");
        let mut out = b"line\n\n__CHM_EXIT_STATUS__0\n".to_vec();
        assert_eq!(take_status(&mut out), Some(0));
        assert_eq!(out, b"line\n", "the script's own trailing newline is kept");
        let mut out = b"killed before the end".to_vec();
        assert_eq!(take_status(&mut out), None);
    }

    /// The generated command really works in a POSIX shell (where one is available).
    #[test]
    fn command_reports_status_and_exact_output() {
        let Ok(sh) = which_sh() else { return };
        let cmd = command_for("printf 'a\\nb'\nexit 7");
        // Stand in for the login shell: run what it would exec.
        let inner = cmd.strip_prefix("exec $SHELL -lc ").expect("login shell wrapper");
        let out = std::process::Command::new(&sh).arg("-c").arg(format!("SHELL={sh}; export SHELL; exec $SHELL -c {inner}")).output().unwrap();
        let mut stdout = strip_before_marker(&out.stdout);
        assert_eq!(take_status(&mut stdout), Some(7));
        assert_eq!(stdout, b"a\nb");
    }

    fn which_sh() -> Result<String, ()> {
        for c in ["/bin/sh", "D:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe"] {
            if std::path::Path::new(c).exists() {
                return Ok(c.to_string());
            }
        }
        Err(())
    }

    #[test]
    fn strips_login_noise() {
        let raw = b"Welcome to Ubuntu\n(base) conda\n__CHM_OUTPUT_BEGINS__\nreal\n";
        assert_eq!(strip_before_marker(raw), b"real\n");
        assert_eq!(strip_before_marker(b"no marker"), b"no marker");
    }
}
