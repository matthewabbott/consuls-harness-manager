//! File operations on This PC.

use std::io::{Read, Write};
use std::path::Path;

use super::git::{self, GitStatus};
use super::{ByteStream, CHUNK, COUNT_CAP, FsOp, NAME_TRIES, base_name, check_name, check_not_inside, numbered, upload_temp};

fn err(path: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", base_name(path))
}

pub(crate) fn op(op: FsOp) -> Result<(), String> {
    match op {
        FsOp::Mkdir { path } => std::fs::create_dir(&path).map_err(err(&path)),
        FsOp::CreateFile { path } => std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()).map_err(err(&path)),
        FsOp::Rename { from, to } => {
            check_not_inside(&from, &to)?;
            // std::fs::rename replaces an existing file on Unix; never do that from the explorer.
            if Path::new(&to).symlink_metadata().is_ok() {
                return Err(format!("{} already exists", base_name(&to)));
            }
            match std::fs::rename(&from, &to) {
                Ok(()) => Ok(()),
                // Another disk: copy, then remove the original.
                Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                    copy_tree(Path::new(&from), Path::new(&to)).map_err(err(&from))?;
                    let meta = Path::new(&from).symlink_metadata().map_err(err(&from))?;
                    if meta.is_dir() { std::fs::remove_dir_all(&from) } else { std::fs::remove_file(&from) }.map_err(err(&from))
                }
                Err(e) => Err(err(&from)(e)),
            }
        }
        FsOp::Copy { from, to } => {
            check_not_inside(&from, &to)?;
            if Path::new(&to).symlink_metadata().is_ok() {
                return Err(format!("{} already exists", base_name(&to)));
            }
            copy_tree(Path::new(&from), Path::new(&to)).map_err(err(&from))
        }
        FsOp::Remove { path } => {
            let meta = Path::new(&path).symlink_metadata().map_err(err(&path))?;
            if meta.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) }.map_err(err(&path))
        }
    }
}

/// Copies a file, a link or a whole folder to `to`, which mustn't exist (nothing is replaced).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = from.symlink_metadata()?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(std::fs::read_link(from)?, to);
        #[cfg(windows)]
        {
            // Making links takes privileges on Windows: a link to a file is copied as the file;
            // one to a folder (or a junction, which may loop) isn't followed.
            if from.is_dir() {
                return Err(std::io::Error::other(format!("{} is a link to a folder, which can't be copied here", from.display())));
            }
            return copy_file(from, to);
        }
    }
    if meta.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        copy_file(from, to)
    }
}

fn copy_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    let mut dst = std::fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    std::io::copy(&mut src, &mut dst)?;
    dst.set_permissions(src.metadata()?.permissions())
}

/// Writes the `len` bytes arriving on `rx` to a new file `name` in `dir` and returns its path:
/// under a temporary name, then linked into place (a hard link never replaces a file) once
/// every byte is there. A taken name gets " (1)", " (2)", …. Blocks: run it off the runtime.
pub(crate) fn upload(dir: &str, name: &str, len: u64, mut rx: ByteStream) -> Result<String, String> {
    check_name(name)?;
    let tmp = upload_temp(dir, name);
    let fail = |e: std::io::Error| format!("{name}: {e}");
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(fail)?;
    let written: Result<(), String> = (|| {
        let mut got = 0u64;
        while let Some(chunk) = rx.blocking_recv() {
            let chunk = chunk?;
            got += chunk.len() as u64;
            if got > len {
                return Err(format!("{name}: more data than announced"));
            }
            file.write_all(&chunk).map_err(fail)?;
        }
        if got != len {
            return Err(format!("{name}: the upload stopped after {got} of {len} bytes"));
        }
        file.sync_all().map_err(fail)
    })();
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let dir = dir.trim_end_matches('/');
    for n in 0..NAME_TRIES {
        let path = format!("{dir}/{}", numbered(name, n));
        let placed = match std::fs::hard_link(&tmp, &path) {
            Ok(()) => std::fs::remove_file(&tmp).map(|_| true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            // No hard links here (FAT, some network shares): check, then rename.
            Err(_) if Path::new(&path).symlink_metadata().is_err() => std::fs::rename(&tmp, &path).map(|_| true),
            Err(_) => Ok(false),
        };
        match placed {
            Ok(true) => return Ok(path),
            Ok(false) => continue,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(fail(e));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!("{name}: too many files with that name already"))
}

/// A file's size and its bytes, read on a blocking thread as they're taken.
pub(crate) fn download(path: &str) -> Result<(u64, ByteStream), String> {
    let mut file = std::fs::File::open(path).map_err(err(path))?;
    let meta = file.metadata().map_err(err(path))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", base_name(path)));
    }
    let size = meta.len();
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let name = base_name(path).to_string();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        let mut left = size;
        while left > 0 {
            let want = buf.len().min(left as usize);
            let sent = match file.read(&mut buf[..want]) {
                Ok(0) => tx.blocking_send(Err(format!("{name} got shorter while downloading"))).map(|_| false),
                Ok(n) => {
                    left -= n as u64;
                    tx.blocking_send(Ok(bytes::Bytes::copy_from_slice(&buf[..n]))).map(|_| true)
                }
                Err(e) => tx.blocking_send(Err(format!("{name}: {e}"))).map(|_| false),
            };
            if !matches!(sent, Ok(true)) {
                break;
            }
        }
    });
    Ok((size, rx))
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
    fn copy_and_move_never_replace() {
        let dir = std::env::temp_dir().join(format!("chm-copy-test-{}", std::process::id()));
        let d = crate::local::to_slash(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/inner")).unwrap();
        std::fs::write(dir.join("src/a.txt"), "a").unwrap();
        std::fs::write(dir.join("src/inner/b.txt"), "b").unwrap();
        op(FsOp::Copy { from: format!("{d}/src"), to: format!("{d}/copy") }).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("copy/inner/b.txt")).unwrap(), "b");
        assert!(op(FsOp::Copy { from: format!("{d}/src/a.txt"), to: format!("{d}/copy/a.txt") }).is_err(), "copy never replaces");
        assert!(op(FsOp::Copy { from: format!("{d}/src"), to: format!("{d}/src/inner/src") }).is_err(), "not into itself");
        assert!(op(FsOp::Rename { from: format!("{d}/src"), to: format!("{d}/src/inner/src") }).is_err(), "not into itself");
        op(FsOp::Rename { from: format!("{d}/src/a.txt"), to: format!("{d}/copy/inner/a.txt") }).unwrap();
        assert!(dir.join("copy/inner/a.txt").exists() && !dir.join("src/a.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn stream(chunks: &[&[u8]], then_drop: bool) -> ByteStream {
        let (tx, rx) = tokio::sync::mpsc::channel(chunks.len() + 1);
        for c in chunks {
            tx.try_send(Ok(bytes::Bytes::copy_from_slice(c))).unwrap();
        }
        if !then_drop {
            tx.try_send(Err("connection lost".into())).unwrap();
        }
        rx
    }

    #[test]
    fn uploads_land_whole_or_not_at_all() {
        let dir = std::env::temp_dir().join(format!("chm-upload-test-{}", std::process::id()));
        let d = crate::local::to_slash(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = upload(&d, "photo.jpg", 6, stream(&[b"abc", b"def"], true)).unwrap();
        assert_eq!(path, format!("{d}/photo.jpg"));
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
        // The name's taken: the next one is numbered; the first is untouched.
        let second = upload(&d, "photo.jpg", 2, stream(&[b"xy"], true)).unwrap();
        assert_eq!(second, format!("{d}/photo (1).jpg"));
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
        // Short, broken off, or too long: nothing is left behind.
        assert!(upload(&d, "short.bin", 10, stream(&[b"abc"], true)).is_err());
        assert!(upload(&d, "broken.bin", 6, stream(&[b"abc"], false)).is_err());
        assert!(upload(&d, "long.bin", 2, stream(&[b"abc"], true)).is_err());
        assert!(upload(&d, "../escape", 1, stream(&[b"a"], true)).is_err());
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["photo (1).jpg", "photo.jpg"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn downloads_stream_the_file() {
        let path = std::env::temp_dir().join(format!("chm-download-test-{}", std::process::id()));
        let body: Vec<u8> = (0..(CHUNK * 2 + 10)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &body).unwrap();
        let (size, mut rx) = download(&crate::local::to_slash(&path)).unwrap();
        assert_eq!(size, body.len() as u64);
        let mut got = Vec::new();
        while let Some(chunk) = rx.blocking_recv() {
            got.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(got, body);
        std::fs::remove_file(&path).unwrap();
        assert!(download(&crate::local::to_slash(&std::env::temp_dir())).is_err(), "not a folder");
    }

    #[test]
    fn pasted_images() {
        let dir = std::env::temp_dir().join(format!("chm-paste-test-{}", std::process::id()));
        let path = save_paste_in(&dir, "paste-1-a.png", b"png").unwrap();
        assert!(path.ends_with("/paste-1-a.png") && !path.contains('\\'));
        assert!(save_paste_in(&dir, "paste-1-a.png", b"x").is_err(), "never overwrites");
        // A week-old paste goes when the next one arrives; other files stay.
        let old = std::fs::File::options().write(true).open(dir.join("paste-1-a.png")).unwrap();
        old.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 3600)).unwrap();
        drop(old);
        std::fs::write(dir.join("notes.txt"), "keep").unwrap();
        save_paste_in(&dir, "paste-2-b.png", b"png").unwrap();
        assert!(!dir.join("paste-1-a.png").exists() && dir.join("notes.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(super::super::paste_name("PNG").unwrap().ends_with(".png"));
        assert!(super::super::paste_name("jpeg").unwrap().ends_with(".jpg"));
        assert_eq!(super::super::paste_name("svg"), None);
    }

    #[test]
    fn head_versions() {
        let here = crate::local::to_slash(Path::new(env!("CARGO_MANIFEST_DIR")));
        match git_head(&format!("{here}/Cargo.toml")).unwrap() {
            git::HeadVersion::Text { text } => assert!(text.contains("[package]")),
            // Not a checkout (e.g. a source tarball): nothing to compare.
            git::HeadVersion::NotInRepo => {}
            other => panic!("unexpected {other:?}"),
        }
        let tmp = std::env::temp_dir().join("chm-not-a-repo-file.txt");
        std::fs::write(&tmp, "x").unwrap();
        let v = git_head(&crate::local::to_slash(&tmp)).unwrap();
        assert!(matches!(v, git::HeadVersion::NotInRepo | git::HeadVersion::Untracked));
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn this_repo_has_a_status() {
        let here = env!("CARGO_MANIFEST_DIR");
        if let Ok(Some(st)) = git_status(here) {
            assert!(Path::new(&st.root).join(".git").exists());
        }
    }
}

use super::{BYTES_LIMIT, EDIT_LIMIT, FileContent, FileStamp, HASH_LIMIT, SaveError, decode, encode, stamp_of, unchanged};

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

pub(crate) fn stat(path: &str) -> Result<Option<FileStamp>, String> {
    match std::fs::metadata(path) {
        Ok(m) => Ok(Some(FileStamp { size: m.len(), mtime: mtime_of(&m), hash: None })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(path)(e)),
    }
}

pub(crate) fn read(path: &str) -> Result<FileContent, String> {
    let meta = std::fs::metadata(path).map_err(err(path))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", base_name(path)));
    }
    if meta.len() > EDIT_LIMIT {
        return Ok(FileContent::TooLarge { stamp: stamp_of(None, meta.len(), mtime_of(&meta)) });
    }
    let bytes = std::fs::read(path).map_err(err(path))?;
    let stamp = stamp_of(Some(&bytes), bytes.len() as u64, mtime_of(&meta));
    Ok(decode(bytes, stamp))
}

pub(crate) fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(err(path))?;
    if meta.len() > BYTES_LIMIT {
        return Err(format!("{} is too large to preview", base_name(path)));
    }
    std::fs::read(path).map_err(err(path))
}

/// Whether a file must be rewritten in place rather than replaced (other hard links, or
/// owned by someone else).
#[cfg(unix)]
fn keep_inode(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid has no preconditions and can't fail.
    let me = unsafe { libc::getuid() };
    meta.nlink() > 1 || (me != 0 && meta.uid() != me)
}

#[cfg(not(unix))]
fn keep_inode(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Saves editor text (same rules as [`super::remote::write`]).
pub(crate) fn write(path: &str, text: &str, bom: bool, expect: Option<FileStamp>) -> Result<FileStamp, SaveError> {
    if let Some(expect) = expect {
        let current = stat(path)?.map(|mut cur| {
            if expect.hash.is_some() && cur.size <= HASH_LIMIT {
                cur.hash = std::fs::read(path).ok().map(|b| super::hash(&b));
            }
            cur
        });
        match current {
            Some(cur) if unchanged(&expect, &cur) => {}
            other => return Err(SaveError::Conflict { current: other }),
        }
    }
    let bytes = encode(text, bom);
    // Write through symlinks.
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let meta = std::fs::metadata(&target).ok();
    let atomic = || -> std::io::Result<()> {
        let dir = target.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
        let tmp = dir.join(format!(".chm-save-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&tmp, &bytes)?;
        if let Some(m) = &meta {
            let _ = std::fs::set_permissions(&tmp, m.permissions());
        }
        std::fs::rename(&tmp, &target).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    };
    // In place when replacing isn't appropriate, or isn't possible (e.g. the file is open in
    // another program on Windows).
    if meta.as_ref().is_some_and(keep_inode) || atomic().is_err() {
        std::fs::write(&target, &bytes).map_err(err(path))?;
    }
    let after = std::fs::metadata(&target).map_err(err(path))?;
    Ok(stamp_of(Some(&bytes), after.len(), mtime_of(&after)))
}

#[cfg(test)]
mod edit_tests {
    use super::*;

    #[test]
    fn crlf_bom_round_trip_and_conflicts() {
        let dir = std::env::temp_dir().join(format!("chm-edit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = crate::local::to_slash(&dir.join("a.txt"));
        let original = b"\xEF\xBB\xBFline one\r\nline two\r\n".to_vec();
        std::fs::write(&path, &original).unwrap();
        let FileContent::Text { text, bom, stamp } = read(&path).unwrap() else { panic!("text") };
        assert!(bom && text.starts_with("line one\r\n"));
        // An unedited save is byte-identical.
        let s2 = write(&path, &text, bom, Some(stamp)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        // Shorter content truncates.
        let s3 = write(&path, "x", false, Some(s2)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"x");
        // Someone else changes it (same size, same second): the hash catches it.
        std::fs::write(&path, b"y").unwrap();
        assert!(matches!(write(&path, "z", false, Some(s3)), Err(SaveError::Conflict { .. })));
        // Saving without an expectation (overwrite) goes through.
        write(&path, "z", false, None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"z");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// The committed (HEAD) version of `path`, for the editor's change gutter.
pub(crate) fn git_head(path: &str) -> Result<git::HeadVersion, String> {
    let (dir, name) = path.rsplit_once('/').unwrap_or((".", path));
    let dir = if dir.is_empty() || dir.ends_with(':') { format!("{dir}/") } else { dir.to_string() };
    let inside = git_cmd().args(["-C", &dir, "rev-parse", "--is-inside-work-tree"]).output();
    if !inside.is_ok_and(|o| o.status.success()) {
        return Ok(git::HeadVersion::NotInRepo);
    }
    let spec = format!("HEAD:./{name}");
    let exists = git_cmd().args(["-C", &dir, "cat-file", "-e", &spec]).output();
    if !exists.is_ok_and(|o| o.status.success()) {
        return Ok(git::HeadVersion::Untracked);
    }
    let out = git_cmd().args(["-C", &dir, "show", &spec]).output().map_err(|e| e.to_string())?;
    Ok(if out.status.success() { git::head_from_bytes(out.stdout) } else { git::HeadVersion::NotInRepo })
}

/// Where images pasted into the composer are kept on This PC.
fn paste_dir() -> std::path::PathBuf {
    dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("consuls").join("pastes")
}

/// Saves an image pasted into the composer and returns its path (forward slashes). Pastes
/// older than a week are removed first.
pub(crate) fn save_paste(name: &str, bytes: &[u8]) -> Result<String, String> {
    save_paste_in(&paste_dir(), name, bytes)
}

fn save_paste_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let week = std::time::Duration::from_secs(super::PASTE_DAYS * 24 * 3600);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > week);
        if old && entry.file_name().to_string_lossy().starts_with("paste-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let path = dir.join(name);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(err(name))?;
    file.write_all(bytes).map_err(err(name))?;
    Ok(crate::local::to_slash(&path))
}
