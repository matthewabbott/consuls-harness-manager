//! "This PC": shells on the machine the app runs on. They are direct panes like remote plain
//! shells, on a local pseudo-console instead of an SSH channel. Hook assets live under the
//! local home and hook events arrive through the local events file (polled).
//!
//! Paths shown to the UI use forward slashes on Windows too (`C:/Users/…`), which every
//! Windows API and Git's `sh` accept.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::harness::Quoting;
use crate::integration::assets::{self, Assets};
use crate::model::{DirEntryInfo, DirListing, HostFacts};

/// Host id of this machine (not in the config; always present, always connected).
pub const LOCAL_HOST: &str = "@local";

/// A shell the user can start on this machine.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalShell {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ShellDef {
    pub shell: LocalShell,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub quoting: Quoting,
}

pub fn to_slash(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    // `\\?\C:\…` from canonicalize on Windows.
    s.strip_prefix("//?/").map(str::to_string).unwrap_or(s)
}

pub fn home() -> String {
    dirs::home_dir().map(|h| to_slash(&h)).unwrap_or_else(|| "/".into())
}

/// Finds an executable on PATH (with PATHEXT on Windows).
fn which(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(|e| e.to_ascii_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|p| p.is_file())
    })
}

/// Git for Windows' install directory (holds `bin/bash.exe` and `usr/bin/sh.exe`).
#[cfg(windows)]
fn git_root() -> Option<PathBuf> {
    if let Some(git) = which("git") {
        // …/Git/cmd/git.exe or …/Git/bin/git.exe or …/Git/mingw64/bin/git.exe
        for up in 2..=3 {
            let root = git.ancestors().nth(up)?;
            if root.join("usr/bin/sh.exe").is_file() {
                return Some(root.to_path_buf());
            }
        }
    }
    ["C:/Program Files/Git", "D:/Program Files/Git", "C:/Program Files (x86)/Git"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.join("usr/bin/sh.exe").is_file())
}

/// The POSIX `sh` that runs hook scripts on this machine.
pub(crate) fn hook_sh() -> Option<String> {
    #[cfg(windows)]
    {
        git_root().map(|r| to_slash(&r.join("usr/bin/sh.exe")))
    }
    #[cfg(not(windows))]
    {
        Some("sh".into())
    }
}

/// Shells available on this machine, most useful first.
pub(crate) fn shell_defs() -> Vec<ShellDef> {
    let mut out = Vec::new();
    let mut add = |id: &str, name: &str, path: PathBuf, args: &[&str], env: &[(&str, &str)], quoting: Quoting| {
        if path.is_file() && !out.iter().any(|d: &ShellDef| d.shell.id == id) {
            out.push(ShellDef {
                shell: LocalShell { id: id.into(), name: name.into(), path: to_slash(&path) },
                args: args.iter().map(|a| a.to_string()).collect(),
                env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                quoting,
            });
        }
    };
    #[cfg(windows)]
    {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:/Windows".into());
        if let Some(p) = which("pwsh").or_else(|| Some(PathBuf::from("C:/Program Files/PowerShell/7/pwsh.exe"))) {
            add("pwsh", "PowerShell", p, &["-NoLogo"], &[], Quoting::PowerShell);
        }
        add(
            "powershell",
            "Windows PowerShell",
            Path::new(&system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            &["-NoLogo"],
            &[],
            Quoting::PowerShell,
        );
        if let Some(root) = git_root() {
            add(
                "git-bash",
                "Git Bash",
                root.join("bin/bash.exe"),
                &["--login", "-i"],
                // Keep the working directory we start in (Git's profile otherwise goes home).
                &[("CHERE_INVOKING", "1"), ("MSYSTEM", "MINGW64")],
                Quoting::Posix,
            );
        }
        let comspec = std::env::var("ComSpec").map(PathBuf::from).unwrap_or_else(|_| Path::new(&system).join("System32/cmd.exe"));
        add("cmd", "Command Prompt", comspec, &[], &[], Quoting::Cmd);
        for distro in wsl_distros() {
            add(
                &format!("wsl:{distro}"),
                &format!("WSL · {distro}"),
                Path::new(&system).join("System32/wsl.exe"),
                &["-d", distro.as_str()],
                &[],
                Quoting::Posix,
            );
        }
    }
    #[cfg(not(windows))]
    {
        let login = std::env::var("SHELL").ok().map(PathBuf::from);
        if let Some(p) = login {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "shell".into());
            add("login", &name, p, &["-l"], &[], Quoting::Posix);
        }
        for name in ["zsh", "bash", "fish"] {
            if let Some(p) = which(name) {
                add(name, name, p, &["-l"], &[], Quoting::Posix);
            }
        }
    }
    out
}

pub fn shells() -> Vec<LocalShell> {
    shell_defs().into_iter().map(|d| d.shell).collect()
}

/// Installed WSL distributions (`wsl -l -q` prints UTF-16).
#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = std::process::Command::new("wsl.exe").args(["-l", "-q"]).creation_flags(CREATE_NO_WINDOW).output() else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let words: Vec<u16> = out.stdout.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
    String::from_utf16_lossy(&words).lines().map(|l| l.trim_matches(['\0', ' ', '\r']).to_string()).filter(|l| !l.is_empty()).collect()
}

pub fn facts() -> HostFacts {
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let machine = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let shell = shell_defs().first().map(|d| d.shell.path.clone()).unwrap_or_default();
    HostFacts {
        user,
        home: home(),
        shell,
        uname: {
            let os = match std::env::consts::OS {
                "windows" => "Windows",
                "macos" => "macOS",
                "linux" => "Linux",
                other => other,
            };
            if machine.is_empty() { os.to_string() } else { format!("{os} · {machine}") }
        },
        tmux_version: None,
    }
}

/// Lists a local directory (dirs first). `~` is the home directory.
pub fn list_dir(path: &str) -> Result<DirListing, String> {
    let home = home();
    let path = if path.is_empty() || path == "~" {
        home.clone()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{rest}", home.trim_end_matches('/'))
    } else {
        path.to_string()
    };
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&canonical).map_err(|e| format!("{path}: {e}"))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Follows symlinks/junctions, like the remote listing.
        let is_dir = entry.path().is_dir();
        entries.push(DirEntryInfo { name, is_dir });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let mut shown = to_slash(&canonical);
    if shown.len() > 3 {
        shown = shown.trim_end_matches('/').to_string();
    }
    Ok(DirListing { path: shown, home, entries })
}

pub(crate) fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")));
    base.unwrap_or_else(|| PathBuf::from(".")).join("consuls")
}

/// Writes the hook assets under the local home (only when they changed).
pub fn ensure_assets() -> Result<Assets, String> {
    let sh = hook_sh().ok_or("Git for Windows (for its sh) wasn't found; hooks need it")?;
    let assets = Assets::with_sh(&home(), &sh);
    let version_path = Path::new(&assets.dir).join("VERSION");
    if std::fs::read_to_string(&version_path).is_ok_and(|v| v == assets::version()) {
        return Ok(assets);
    }
    std::fs::create_dir_all(&assets.dir).map_err(|e| format!("{}: {e}", assets.dir))?;
    for (path, content, _mode) in assets::files(&assets, "tmux") {
        std::fs::write(&path, content).map_err(|e| format!("writing {path}: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(_mode));
        }
    }
    Ok(assets)
}

/// Environment for a local shell of pane `chm_id`.
pub(crate) fn pane_env(def: &ShellDef, chm_id: &str) -> Vec<(String, String)> {
    let mut env = def.env.clone();
    env.push(("CHM_PANE".into(), format!("direct:{chm_id}")));
    env.push(("CHM_STATE_DIR".into(), to_slash(&state_dir())));
    env.push(("COLORTERM".into(), "truecolor".into()));
    if def.quoting == Quoting::Posix {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    env
}

/// Follows the local events file, handing each complete line to `on_line`. Starts at the
/// current end (older events belong to sessions that are gone).
pub(crate) async fn tail_events(on_line: Arc<dyn Fn(&str) + Send + Sync>) {
    let path = state_dir().join("events.jsonl");
    let _ = std::fs::create_dir_all(state_dir());
    let mut offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut partial: Vec<u8> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(400));
    loop {
        tick.tick().await;
        let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else { continue };
        if len < offset {
            offset = 0; // truncated or replaced
            partial.clear();
        }
        if len == offset {
            continue;
        }
        let Ok(mut f) = std::fs::File::open(&path) else { continue };
        if f.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut buf = Vec::new();
        if f.take(len - offset).read_to_end(&mut buf).is_err() {
            continue;
        }
        offset += buf.len() as u64;
        partial.extend_from_slice(&buf);
        while let Some(pos) = partial.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = partial.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if !line.trim().is_empty() {
                on_line(line.trim());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slashes() {
        assert_eq!(to_slash(Path::new(r"C:\Users\A B\x")), "C:/Users/A B/x");
        assert_eq!(to_slash(Path::new(r"\\?\C:\Users")), "C:/Users");
    }

    #[test]
    fn lists_and_finds_shells() {
        let home_listing = list_dir("~").unwrap();
        assert_eq!(home_listing.path, home());
        assert!(!shells().is_empty(), "at least one local shell");
    }
}
