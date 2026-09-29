//! The notifier's only footprint on a machine: `/tmp/consuls-<uid>/` (its binary, the control
//! socket, the core's scratch files). Private to the user, and removed when the notifier stops;
//! `/tmp` is cleared at boot anyway.

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::bail;

pub struct RunDir {
    path: PathBuf,
}

impl RunDir {
    /// `$CONSULS_NOTIFIER_DIR`, else `/tmp/consuls-<uid>`.
    pub fn default_path() -> PathBuf {
        match std::env::var_os("CONSULS_NOTIFIER_DIR") {
            Some(dir) => PathBuf::from(dir),
            // SAFETY: getuid has no failure mode.
            None => PathBuf::from(format!("/tmp/consuls-{}", unsafe { libc::getuid() })),
        }
    }

    /// Creates it (0700), or takes the one there if it's a real directory of ours.
    pub fn prepare(path: PathBuf) -> anyhow::Result<Self> {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) => {
                // SAFETY: getuid has no failure mode.
                let me = unsafe { libc::getuid() };
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    bail!("{} isn't a directory", path.display());
                }
                if meta.uid() != me {
                    bail!("{} belongs to someone else", path.display());
                }
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&path)?;
            }
            Err(e) => return Err(e.into()),
        }
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn socket(&self) -> PathBuf {
        self.path.join("ctl.sock")
    }

    /// The core's data folder (its config and known hosts, rebuilt at each start).
    pub fn core_dir(&self) -> PathBuf {
        self.path.join("core")
    }

    /// Removes everything, the notifier's own binary included.
    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }

    /// Marks every file as used: macOS's daily `/tmp` cleaner deletes files untouched for three
    /// days, which would take the control socket and the binary from a long-running notifier.
    pub fn touch(&self) {
        fn walk(dir: &Path) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(c) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) {
                    // SAFETY: a valid NUL-terminated path; a null `times` means "now".
                    unsafe { libc::utimes(c.as_ptr(), std::ptr::null()) };
                }
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    walk(&path);
                }
            }
        }
        walk(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_removed_whole() {
        let base = std::env::temp_dir().join(format!("chm-rundir-{}", std::process::id()));
        let dir = RunDir::prepare(base.join("run")).unwrap();
        assert_eq!(std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::create_dir_all(dir.core_dir()).unwrap();
        std::fs::write(dir.path().join("bin"), b"x").unwrap();
        dir.touch();
        // Taking it again (the uploader made it) keeps it.
        let again = RunDir::prepare(base.join("run")).unwrap();
        again.cleanup();
        assert!(!base.join("run").exists());
        // A symlink in its place is refused.
        std::os::unix::fs::symlink("/tmp", base.join("link")).unwrap();
        assert!(RunDir::prepare(base.join("link")).is_err());
        let _ = std::fs::remove_dir_all(base);
    }
}
