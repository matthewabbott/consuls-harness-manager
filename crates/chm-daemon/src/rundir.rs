//! The server's runtime folder: `/tmp/consuls-<uid>/` (its control socket and the web API's
//! socket). Private to the user, removed whenever the server stops; `/tmp` is cleared at boot
//! anyway. What lasts between runs is in the install folder (`home.rs`).

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::bail;

/// Creates `path` (0700), or takes the one there if it's a real directory of ours.
pub fn private_dir(path: &Path) -> anyhow::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            // SAFETY: getuid has no failure mode.
            let me = unsafe { libc::getuid() };
            if meta.file_type().is_symlink() || !meta.is_dir() {
                bail!("{} isn't a directory", path.display());
            }
            if meta.uid() != me {
                bail!("{} belongs to someone else", path.display());
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

pub struct RunDir {
    path: PathBuf,
}

impl RunDir {
    /// `$CONSULS_SERVER_RUN`, else `/tmp/consuls-<uid>`.
    pub fn default_path() -> PathBuf {
        match std::env::var_os("CONSULS_SERVER_RUN") {
            Some(dir) => PathBuf::from(dir),
            // SAFETY: getuid has no failure mode.
            None => PathBuf::from(format!("/tmp/consuls-{}", unsafe { libc::getuid() })),
        }
    }

    pub fn prepare(path: PathBuf) -> anyhow::Result<Self> {
        private_dir(&path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn socket(&self) -> PathBuf {
        self.path.join("ctl.sock")
    }

    /// The web API's socket, which `tailscale serve` (root) proxies to: nobody else on the
    /// machine can reach the API and claim to be the owner.
    pub fn web_socket(&self) -> PathBuf {
        self.path.join("web.sock")
    }

    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }

    /// Marks every file as used: macOS's daily `/tmp` cleaner deletes files untouched for three
    /// days, which would take the sockets from a long-running server.
    pub fn touch(&self) {
        let Ok(entries) = std::fs::read_dir(&self.path) else { return };
        for entry in entries.flatten() {
            if let Ok(c) = std::ffi::CString::new(entry.path().as_os_str().as_encoded_bytes()) {
                // SAFETY: a valid NUL-terminated path; a null `times` means "now".
                unsafe { libc::utimes(c.as_ptr(), std::ptr::null()) };
            }
        }
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
        std::fs::write(dir.socket(), b"x").unwrap();
        dir.touch();
        // Taking it again keeps it.
        let again = RunDir::prepare(base.join("run")).unwrap();
        again.cleanup();
        assert!(!base.join("run").exists());
        // A symlink in its place is refused.
        std::os::unix::fs::symlink("/tmp", base.join("link")).unwrap();
        assert!(RunDir::prepare(base.join("link")).is_err());
        let _ = std::fs::remove_dir_all(base);
    }
}
