//! File operations on This PC.

use std::path::Path;

use super::git::{self, GitStatus};
use super::{COUNT_CAP, FsOp, base_name};

fn err(path: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", base_name(path))
}

pub(crate) fn op(op: FsOp) -> Result<(), String> {
    match op {
        FsOp::Mkdir { path } => std::fs::create_dir(&path).map_err(err(&path)),
        FsOp::CreateFile { path } => std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()).map_err(err(&path)),
        FsOp::Rename { from, to } => {
            // std::fs::rename replaces an existing file on Unix; never do that from the explorer.
            if Path::new(&to).symlink_metadata().is_ok() {
                return Err(format!("{} already exists", base_name(&to)));
            }
            std::fs::rename(&from, &to).map_err(err(&from))
        }
        FsOp::Remove { path } => {
            let meta = Path::new(&path).symlink_metadata().map_err(err(&path))?;
            if meta.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) }.map_err(err(&path))
        }
    }
}

/// Items under `path` (not counting itself), up to [`COUNT_CAP`] + 1.
pub(crate) fn count(path: &str) -> Result<u64, String> {
    let mut n = 0u64;
    let mut stack = vec![std::path::PathBuf::from(path)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            n += 1;
            if n > COUNT_CAP {
                return Ok(n);
            }
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(e.path());
            }
        }
    }
    Ok(n)
}

fn git_cmd() -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// `git status` for the repository containing `dir`; `None` if it isn't in one (or git is missing).
pub(crate) fn git_status(dir: &str) -> Result<Option<GitStatus>, String> {
    let Ok(top) = git_cmd().args(["-C", dir, "rev-parse", "--show-toplevel"]).output() else { return Ok(None) };
    if !top.status.success() {
        return Ok(None);
    }
    let root = String::from_utf8_lossy(&top.stdout).trim().replace('\\', "/");
    let out = git_cmd().arg("-C").arg(&root).args(git::STATUS_ARGS).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let (branch, entries) = git::parse(&out.stdout);
    Ok(Some(GitStatus { root, branch, entries }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_on_a_temp_dir() {
        let dir = std::env::temp_dir().join(format!("chm-fs-test-{}", std::process::id()));
        let d = crate::local::to_slash(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        op(FsOp::Mkdir { path: format!("{d}/sub") }).unwrap();
        op(FsOp::CreateFile { path: format!("{d}/sub/a.txt") }).unwrap();
        assert!(op(FsOp::CreateFile { path: format!("{d}/sub/a.txt") }).is_err(), "never overwrites");
        op(FsOp::CreateFile { path: format!("{d}/b.txt") }).unwrap();
        assert!(op(FsOp::Rename { from: format!("{d}/b.txt"), to: format!("{d}/sub/a.txt") }).is_err(), "rename never replaces");
        op(FsOp::Rename { from: format!("{d}/b.txt"), to: format!("{d}/c.txt") }).unwrap();
        assert_eq!(count(&d).unwrap(), 3); // sub, sub/a.txt, c.txt
        op(FsOp::Remove { path: format!("{d}/sub") }).unwrap();
        assert_eq!(count(&d).unwrap(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn this_repo_has_a_status() {
        let here = env!("CARGO_MANIFEST_DIR");
        if let Ok(Some(st)) = git_status(here) {
            assert!(Path::new(&st.root).join(".git").exists());
        }
    }
}
