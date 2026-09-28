//! tmux on Windows, through Cygwin (tmux needs a POSIX system; Cygwin's is a native Windows
//! one, so its panes run Windows programs with a real console and see the same files).
//!
//! Cygwin names things its own way (`/cygdrive/d/a`, `/home/me`), so pane folders go through
//! its mount table on the way to the UI; the other direction needs nothing, since Cygwin
//! accepts Windows paths (`D:/a`).

use std::path::PathBuf;
use std::sync::Arc;

use crate::link::LocalSh;

/// A Cygwin installation with tmux.
#[derive(Debug, Clone)]
pub struct Cygwin {
    pub root: PathBuf,
}

impl Cygwin {
    /// Finds Cygwin (its setup's registry entry, then the usual folders); `None` without tmux.
    pub fn find() -> Option<Self> {
        let mut candidates: Vec<PathBuf> = registry_root().into_iter().collect();
        candidates.extend(["C:/cygwin64", "D:/cygwin64", "C:/cygwin", "D:/cygwin"].map(PathBuf::from));
        candidates.into_iter().find(|r| r.join("bin/tmux.exe").is_file() && r.join("bin/bash.exe").is_file()).map(|root| Self { root })
    }

    pub fn tmux(&self) -> PathBuf {
        self.root.join("bin/tmux.exe")
    }

    /// The shell that runs scripts and control clients. `state_dir` is where hooks append
    /// events (this PC's events file).
    pub fn shell(&self, state_dir: &str) -> Arc<LocalSh> {
        Arc::new(LocalSh {
            sh: self.root.join("bin/bash.exe"),
            env: vec![
                ("SHELL".into(), "/bin/bash".into()),
                // Cygwin's profile otherwise starts every login shell in $HOME.
                ("CHERE_INVOKING".into(), "1".into()),
                ("CHM_STATE_DIR".into(), state_dir.into()),
            ],
            control_needs_pty: true,
        })
    }
}

#[cfg(windows)]
fn registry_root() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (key, value) = (wide("SOFTWARE\\Cygwin\\setup"), wide("rootdir"));
    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: NUL-terminated inputs we own; `len` is the buffer size in bytes.
    let rc = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len)
    };
    if rc != 0 {
        return None;
    }
    let chars = (len as usize / 2).saturating_sub(1);
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..chars])))
}

#[cfg(not(windows))]
fn registry_root() -> Option<PathBuf> {
    None
}

/// Cygwin's mounts (from `mount`), to turn its paths into Windows ones.
#[derive(Debug, Clone, Default)]
pub struct PathMap {
    /// (POSIX mount point, Windows folder), longest mount point first.
    mounts: Vec<(String, String)>,
}

impl PathMap {
    /// Parses `mount` output: `D:/cygwin64/bin on /usr/bin type ntfs (binary,auto)`.
    pub fn parse(mount_output: &str) -> Self {
        let mut mounts: Vec<(String, String)> = mount_output
            .lines()
            .filter_map(|line| {
                let line = &line[..line.rfind(" type ")?];
                let at = line.find(" on /")?;
                let win = line[..at].replace('\\', "/");
                let posix = line[at + 4..].to_string();
                Some((posix, win.trim_end_matches('/').to_string()))
            })
            .collect();
        mounts.sort_by_key(|m| std::cmp::Reverse(m.0.len()));
        Self { mounts }
    }

    /// `/cygdrive/d/a` → `D:/a`, `/home/me` → `D:/cygwin64/home/me`. Windows paths (and
    /// anything unmapped) pass through.
    pub fn to_windows(&self, posix: &str) -> String {
        if !posix.starts_with('/') {
            return posix.to_string();
        }
        for (mount, win) in &self.mounts {
            let rest = if mount == "/" {
                Some(posix)
            } else {
                posix.strip_prefix(mount.as_str()).filter(|r| r.is_empty() || r.starts_with('/'))
            };
            if let Some(rest) = rest {
                let rest = rest.trim_start_matches('/');
                // A drive root keeps its slash (`D:/`).
                return if rest.is_empty() && win.ends_with(':') { format!("{win}/") } else if rest.is_empty() { win.clone() } else { format!("{win}/{rest}") };
            }
        }
        posix.to_string()
    }

    /// `D:/a` → `/cygdrive/d/a` (tmux's `-c` doesn't take Windows paths). POSIX paths (and
    /// anything unmapped) pass through.
    pub fn to_posix(&self, win: &str) -> String {
        let w = win.replace('\\', "/");
        let mut best: Option<&(String, String)> = None;
        for m in &self.mounts {
            let prefix = m.1.to_ascii_lowercase();
            let lower = w.to_ascii_lowercase();
            let fits = lower == prefix || lower.starts_with(&format!("{prefix}/"));
            if fits && best.is_none_or(|b| m.1.len() > b.1.len()) {
                best = Some(m);
            }
        }
        match best {
            Some((posix, prefix)) => {
                let rest = w[prefix.len()..].trim_start_matches('/');
                let base = posix.trim_end_matches('/');
                if rest.is_empty() { if base.is_empty() { "/".into() } else { base.to_string() } } else { format!("{base}/{rest}") }
            }
            None => w,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_cygwin_paths_to_windows() {
        let m = PathMap::parse(
            "D:/cygwin64/bin on /usr/bin type ntfs (binary,auto)\n\
             D:/cygwin64/lib on /usr/lib type ntfs (binary,auto)\n\
             D:/cygwin64 on / type ntfs (binary,auto)\n\
             C: on /cygdrive/c type ntfs (binary,posix=0,user,noumount,auto)\n\
             D: on /cygdrive/d type ntfs (binary,posix=0,user,noumount,auto)\n\
             D:/Program Files/Shared on /shared type ntfs (binary,user)\n",
        );
        assert_eq!(m.to_windows("/cygdrive/d/a/programming"), "D:/a/programming");
        assert_eq!(m.to_windows("/cygdrive/c"), "C:/");
        assert_eq!(m.to_windows("/home/Matthew Abbott"), "D:/cygwin64/home/Matthew Abbott");
        assert_eq!(m.to_windows("/usr/bin"), "D:/cygwin64/bin");
        assert_eq!(m.to_windows("/usr/binx"), "D:/cygwin64/usr/binx");
        assert_eq!(m.to_windows("/"), "D:/cygwin64");
        assert_eq!(m.to_windows("/shared/x"), "D:/Program Files/Shared/x");
        assert_eq!(m.to_windows("D:/a"), "D:/a");
        assert_eq!(PathMap::default().to_windows("/tmp"), "/tmp");

        assert_eq!(m.to_posix("D:/a/programming"), "/cygdrive/d/a/programming");
        assert_eq!(m.to_posix("c:/Users/A B"), "/cygdrive/c/Users/A B");
        assert_eq!(m.to_posix("D:/"), "/cygdrive/d");
        assert_eq!(m.to_posix("D:/cygwin64/home/me"), "/home/me");
        assert_eq!(m.to_posix("D:/cygwin64"), "/");
        assert_eq!(m.to_posix("D:/Program Files/Shared/x"), "/shared/x");
        assert_eq!(m.to_posix("/already/posix"), "/already/posix");
    }
}
