//! File operations on a remote machine: SFTP over one pooled session per connection (sshd
//! limits channels per connection), plus a couple of shell commands SFTP can't do well
//! (recursive delete, counting a tree).

use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::AsyncWriteExt;

use super::git::{self, GitStatus};
use super::{COUNT_CAP, FsOp, base_name};
use crate::model::{DirEntryInfo, DirListing};
use crate::ssh::SshConnection;
use crate::ssh::exec::{self, sh_quote};

/// One SFTP session per connection, opened on first use and reopened after an error.
#[derive(Clone, Default)]
pub(crate) struct SftpPool(Arc<tokio::sync::Mutex<Option<Arc<SftpSession>>>>);

impl SftpPool {
    async fn get(&self, conn: &SshConnection) -> Result<Arc<SftpSession>, String> {
        let mut slot = self.0.lock().await;
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let s = Arc::new(conn.open_sftp().await.map_err(|e| format!("couldn't open SFTP: {e}"))?);
        *slot = Some(s.clone());
        Ok(s)
    }

    async fn reset(&self) {
        if let Some(s) = self.0.lock().await.take() {
            let _ = s.close().await;
        }
    }

    /// Runs `f` with the session; if it fails because the session died, reopens once and retries.
    async fn with<T, F, Fut>(&self, conn: &SshConnection, f: F) -> Result<T, String>
    where
        F: Fn(Arc<SftpSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, russh_sftp::client::error::Error>>,
    {
        let s = self.get(conn).await?;
        match f(s).await {
            Ok(v) => Ok(v),
            Err(e) if is_session_error(&e) => {
                self.reset().await;
                f(self.get(conn).await?).await.map_err(|e| e.to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub async fn close(&self) {
        self.reset().await;
    }
}

fn is_session_error(e: &russh_sftp::client::error::Error) -> bool {
    use russh_sftp::client::error::Error;
    matches!(e, Error::Timeout | Error::UnexpectedBehavior(_) | Error::IO(_)) || e.to_string().contains("closed")
}

fn expand(home: &str, path: &str) -> String {
    if path.is_empty() || path == "~" {
        home.to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{rest}", home.trim_end_matches('/'))
    } else {
        path.to_string()
    }
}

/// Lists a directory (dirs first). `~` expands to the user's home.
pub(crate) async fn list_dir(conn: &SshConnection, pool: &SftpPool, home: &str, path: &str) -> Result<DirListing, String> {
    let path = expand(home, path);
    pool.with(conn, |sftp| {
        let path = path.clone();
        async move {
            let canonical = sftp.canonicalize(path.clone()).await?;
            let mut entries = Vec::new();
            for entry in sftp.read_dir(canonical.clone()).await? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let meta = entry.metadata();
                let is_symlink = meta.is_symlink();
                let target = if is_symlink {
                    sftp.metadata(format!("{}/{name}", canonical.trim_end_matches('/'))).await.ok()
                } else {
                    None
                };
                let m = target.as_ref().unwrap_or(&meta);
                entries.push(DirEntryInfo {
                    name,
                    is_dir: m.is_dir(),
                    is_symlink,
                    size: m.size.unwrap_or(0),
                    mtime: m.mtime.unwrap_or(0) as u64,
                });
            }
            entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
            Ok(DirListing { path: canonical, home: String::new(), entries })
        }
    })
    .await
    .map(|mut l| {
        l.home = home.to_string();
        l
    })
    .map_err(|e| format!("{path}: {e}"))
}

pub(crate) async fn op(conn: &SshConnection, pool: &SftpPool, op: FsOp) -> Result<(), String> {
    match op {
        FsOp::Mkdir { path } => pool.with(conn, |s| {
            let p = path.clone();
            async move { s.create_dir(p).await }
        }).await.map_err(|e| format!("{}: {e}", base_name(&path))),
        FsOp::CreateFile { path } => pool
            .with(conn, |s| {
                let path = path.clone();
                async move {
                    let mut f = s.open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await?;
                    let _ = f.shutdown().await;
                    Ok(())
                }
            })
            .await
            .map_err(|e| format!("{}: {e}", base_name(&path))),
        FsOp::Rename { from, to } => {
            if pool.with(conn, |s| {
                let t = to.clone();
                async move { s.try_exists(t).await }
            }).await? {
                return Err(format!("{} already exists", base_name(&to)));
            }
            pool.with(conn, |s| {
                let (f, t) = (from.clone(), to.clone());
                async move { s.rename(f, t).await }
            }).await.map_err(|e| format!("{}: {e}", base_name(&from)))
        }
        FsOp::Remove { path } => {
            let meta = pool.with(conn, |s| {
                let p = path.clone();
                async move { s.symlink_metadata(p).await }
            }).await.map_err(|e| format!("{}: {e}", base_name(&path)))?;
            if meta.is_dir() {
                // SFTP can only remove empty directories.
                let out = exec::run(conn, &format!("rm -rf -- {}", sh_quote(&path)), Duration::from_secs(120)).await.map_err(|e| e.to_string())?;
                if !out.success() {
                    return Err(out.stderr_str().trim().to_string());
                }
                Ok(())
            } else {
                pool.with(conn, |s| {
                    let p = path.clone();
                    async move { s.remove_file(p).await }
                }).await.map_err(|e| format!("{}: {e}", base_name(&path)))
            }
        }
    }
}

/// Items under `path` (not counting itself), up to [`COUNT_CAP`] + 1.
pub(crate) async fn count(conn: &SshConnection, path: &str) -> Result<u64, String> {
    let script = format!("find {} -xdev 2>/dev/null | head -n {} | wc -l", sh_quote(path), COUNT_CAP + 2);
    let out = exec::run(conn, &script, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    Ok(out.stdout_str().trim().parse::<u64>().unwrap_or(1).saturating_sub(1))
}

/// `git status` for the repository containing `dir`; `None` if it isn't in one.
pub(crate) async fn git_status(conn: &SshConnection, dir: &str) -> Result<Option<GitStatus>, String> {
    let out = exec::run(conn, &git::remote_script(dir), Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    match out.status {
        Some(0) => {}
        Some(3) => return Err(format!("{dir}: no such directory")),
        Some(4) => return Ok(None),
        _ if out.stderr_str().contains("not found") => return Ok(None), // no git on the host
        _ => return Err(out.stderr_str().trim().to_string()),
    }
    let Some(split) = out.stdout.iter().position(|&b| b == 0) else { return Ok(None) };
    let root = String::from_utf8_lossy(&out.stdout[..split]).trim().to_string();
    let (branch, entries) = git::parse(&out.stdout[split + 1..]);
    Ok(Some(GitStatus { root, branch, entries }))
}

use super::{BYTES_LIMIT, EDIT_LIMIT, FileContent, FileStamp, HASH_LIMIT, SaveError, decode, encode, stamp_of, unchanged};

/// Size and mtime of `path` (following symlinks); `None` if it doesn't exist.
pub(crate) async fn stat(conn: &SshConnection, pool: &SftpPool, path: &str) -> Result<Option<FileStamp>, String> {
    let r = pool
        .with(conn, |s| {
            let p = path.to_string();
            async move { s.metadata(p).await }
        })
        .await;
    match r {
        Ok(m) => Ok(Some(FileStamp { size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as u64, hash: None })),
        Err(e) if e.contains("No such file") || e.contains("not found") => Ok(None),
        Err(e) => Err(format!("{}: {e}", base_name(path))),
    }
}

async fn read_all(conn: &SshConnection, pool: &SftpPool, path: &str) -> Result<Vec<u8>, String> {
    pool.with(conn, |s| {
        let p = path.to_string();
        async move { s.read(p).await }
    })
    .await
    .map_err(|e| format!("{}: {e}", base_name(path)))
}

/// Reads a file for the editor.
pub(crate) async fn read(conn: &SshConnection, pool: &SftpPool, path: &str) -> Result<FileContent, String> {
    let meta = pool
        .with(conn, |s| {
            let p = path.to_string();
            async move { s.metadata(p).await }
        })
        .await
        .map_err(|e| format!("{}: {e}", base_name(path)))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", base_name(path)));
    }
    let (size, mtime) = (meta.size.unwrap_or(0), meta.mtime.unwrap_or(0) as u64);
    if size > EDIT_LIMIT {
        return Ok(FileContent::TooLarge { stamp: stamp_of(None, size, mtime) });
    }
    let bytes = read_all(conn, pool, path).await?;
    let stamp = stamp_of(Some(&bytes), bytes.len() as u64, mtime);
    Ok(decode(bytes, stamp))
}

/// Raw bytes (image preview), up to [`BYTES_LIMIT`].
pub(crate) async fn read_bytes(conn: &SshConnection, pool: &SftpPool, path: &str) -> Result<Vec<u8>, String> {
    if let Some(st) = stat(conn, pool, path).await?
        && st.size > BYTES_LIMIT
    {
        return Err(format!("{} is too large to preview", base_name(path)));
    }
    read_all(conn, pool, path).await
}

/// The save script: resolves symlinks, keeps the mode, lands the new content atomically
/// (temp file + mv), except in place for files with other hard links, owned by someone else,
/// or in a folder we can't write. Reads the content from stdin; prints the new size and mtime.
const SAVE_SCRIPT: &str = r#"f=$(readlink -f -- "$p" 2>/dev/null); [ -n "$f" ] || f=$p
d=$(dirname -- "$f"); mode=; inplace=
if [ -e "$f" ]; then
  links=$(stat -c %h -- "$f" 2>/dev/null || stat -f %l -- "$f" 2>/dev/null || echo 1)
  if [ "$links" -gt 1 ] || [ ! -w "$d" ] || [ ! -O "$f" ]; then
    cat > "$f" || exit 5
    inplace=1
  else
    mode=$(stat -c %a -- "$f" 2>/dev/null || stat -f %Lp -- "$f" 2>/dev/null)
  fi
fi
if [ -z "$inplace" ]; then
  tmp=$(mktemp "$d/.chm-save.XXXXXX") || exit 6
  if ! cat > "$tmp"; then rm -f -- "$tmp"; exit 5; fi
  [ -n "$mode" ] && chmod "$mode" "$tmp"
  mv -f -- "$tmp" "$f" || { rm -f -- "$tmp"; exit 7; }
fi
m=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f")
s=$(wc -c < "$f" | tr -d ' ')
printf 'STAMP %s %s\n' "$s" "$m""#;

/// Saves editor text. With `expect`, refuses (Conflict) if the file changed since it was read.
pub(crate) async fn write(
    conn: &SshConnection,
    pool: &SftpPool,
    path: &str,
    text: &str,
    bom: bool,
    expect: Option<FileStamp>,
) -> Result<FileStamp, SaveError> {
    if let Some(expect) = expect {
        let current = match stat(conn, pool, path).await? {
            Some(mut cur) => {
                if expect.hash.is_some() && cur.size <= HASH_LIMIT {
                    cur.hash = Some(super::hash(&read_all(conn, pool, path).await?));
                }
                Some(cur)
            }
            None => None,
        };
        match current {
            Some(cur) if unchanged(&expect, &cur) => {}
            other => return Err(SaveError::Conflict { current: other }),
        }
    }
    let bytes = encode(text, bom);
    let script = format!("p={}\n{SAVE_SCRIPT}", sh_quote(path));
    let out = exec::run_with_stdin(conn, &script, Some(&bytes), Duration::from_secs(60)).await.map_err(|e| e.to_string())?;
    if !out.success() {
        let err = out.stderr_str();
        let message = if err.trim().is_empty() { format!("save failed (status {:?})", out.status) } else { err.trim().to_string() };
        return Err(SaveError::Failed { message });
    }
    let stdout = out.stdout_str();
    let line = stdout.lines().rev().find_map(|l| l.strip_prefix("STAMP ")).ok_or("save didn't report the new file".to_string())?;
    let mut parts = line.split_whitespace().map(|v| v.parse::<u64>().unwrap_or(0));
    let (size, mtime) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    Ok(stamp_of(Some(&bytes), size, mtime))
}

/// The committed (HEAD) version of `path`, for the editor's change gutter.
pub(crate) async fn git_head(conn: &SshConnection, path: &str) -> Result<git::HeadVersion, String> {
    let out = exec::run(conn, &git::head_script(path), Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    Ok(match out.status {
        Some(0) => git::head_from_bytes(out.stdout),
        Some(5) => git::HeadVersion::Untracked,
        _ => git::HeadVersion::NotInRepo,
    })
}
