//! "Open in VS Code": finds VS Code on this machine and opens a local path in it, or a path on
//! another machine through the Remote-SSH extension, reusing an `~/.ssh/config` alias when one
//! already points at that machine (so VS Code sees the host it knows).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use chm_core::model::{HostConfig, TailnetPeer};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct VsCode {
    /// On Windows `Code.exe` itself: the `code` on PATH is a batch file, and batch files can't
    /// be given arbitrary arguments safely.
    pub exe: PathBuf,
    pub remote_ssh: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeStatus {
    pub installed: bool,
    pub remote_ssh: bool,
}

impl VsCode {
    pub fn detect() -> Option<Self> {
        let exe = candidates().into_iter().find(|p| p.is_file())?;
        let extensions = Path::new(&chm_core::local::home()).join(".vscode/extensions");
        Some(Self { exe, remote_ssh: has_remote_ssh(&extensions) })
    }

    pub fn status(me: &Option<Self>) -> VsCodeStatus {
        VsCodeStatus { installed: me.is_some(), remote_ssh: me.as_ref().is_some_and(|v| v.remote_ssh) }
    }

    /// Starts VS Code (or hands the request to the running instance) without waiting for it.
    pub fn open(&self, target: &Target) -> std::io::Result<()> {
        let mut cmd = std::process::Command::new(&self.exe);
        cmd.args(args(target)).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        // Started from a VS Code terminal, we'd pass on variables that make Code act as a CLI.
        cmd.env_remove("ELECTRON_RUN_AS_NODE");
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().starts_with("VSCODE_") {
                cmd.env_remove(k);
            }
        }
        let mut child = cmd.spawn()?;
        // Reap it (the macOS/Linux `code` script exits as soon as it has handed over).
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // …\Microsoft VS Code\bin\code.cmd → …\Microsoft VS Code\Code.exe
    if let Some(dir) = chm_core::local::which("code").and_then(|cmd| cmd.parent()?.parent().map(Path::to_path_buf)) {
        out.push(dir.join("Code.exe"));
    }
    if let Ok(d) = std::env::var("LOCALAPPDATA") {
        out.push(Path::new(&d).join("Programs/Microsoft VS Code/Code.exe"));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(d) = std::env::var(var) {
            out.push(Path::new(&d).join("Microsoft VS Code/Code.exe"));
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    let app = "Visual Studio Code.app/Contents/Resources/app/bin/code";
    let mut out = vec![Path::new("/Applications").join(app), Path::new(&chm_core::local::home()).join("Applications").join(app)];
    out.extend(chm_core::local::which("code"));
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates() -> Vec<PathBuf> {
    chm_core::local::which("code").into_iter().collect()
}

fn has_remote_ssh(extensions: &Path) -> bool {
    std::fs::read_dir(extensions).is_ok_and(|dir| dir.flatten().any(|e| is_remote_ssh(&e.file_name().to_string_lossy())))
}

/// `ms-vscode-remote.remote-ssh-0.120.0` (not `…remote-ssh-edit-…`).
fn is_remote_ssh(dir: &str) -> bool {
    dir.strip_prefix("ms-vscode-remote.remote-ssh-").is_some_and(|v| v.starts_with(|c: char| c.is_ascii_digit()))
}

/// What to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Local { path: PathBuf, line: Option<u32>, col: Option<u32> },
    /// `authority` is what follows `ssh-remote+`.
    Remote { authority: String, path: String, line: Option<u32>, col: Option<u32> },
}

fn goto(path: &str, line: Option<u32>, col: Option<u32>) -> Vec<OsString> {
    match line {
        Some(l) => vec!["--goto".into(), format!("{path}:{l}{}", col.map(|c| format!(":{c}")).unwrap_or_default()).into()],
        None => vec![path.into()],
    }
}

pub fn args(target: &Target) -> Vec<OsString> {
    match target {
        Target::Local { path, line, col } => {
            if line.is_some() {
                goto(&path.to_string_lossy(), *line, *col)
            } else {
                vec![path.clone().into_os_string()]
            }
        }
        Target::Remote { authority, path, line, col } => {
            let mut a: Vec<OsString> = vec!["--remote".into(), format!("ssh-remote+{authority}").into()];
            a.extend(goto(path, *line, *col));
            a
        }
    }
}

/// How Remote-SSH should reach `host`: an ssh-config alias for it, `user@name`, or (for a
/// non-standard port) Remote-SSH's hex-encoded JSON form.
pub fn authority(host: &HostConfig, peer: Option<&TailnetPeer>, ssh_config: &str) -> String {
    let mut names: Vec<String> = Vec::new();
    names.extend(host.address.clone());
    if let Some(p) = peer {
        names.push(p.dns_name.clone());
        names.push(p.host_name.clone());
        names.extend(p.ips.iter().cloned());
    }
    names.push(host.id.clone());
    let names: Vec<String> = names.iter().map(|n| norm(n)).filter(|n| !n.is_empty()).collect();
    if let Some(alias) = ssh_alias(ssh_config, &names, &host.user, host.port) {
        return alias;
    }
    let name = host.address.clone().or_else(|| peer.map(|p| p.dns_name.clone()).filter(|d| !d.is_empty())).unwrap_or_else(|| host.id.clone());
    if host.port == 22 {
        format!("{}@{name}", host.user)
    } else {
        let json = serde_json::json!({ "hostName": name, "user": host.user, "port": host.port }).to_string();
        json.bytes().map(|b| format!("{b:02x}")).collect()
    }
}

fn norm(name: &str) -> String {
    name.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// The first concrete `Host` alias in `config` that points at one of `names` as `user` on `port`.
/// With no `User` in the block, the alias is prefixed with ours (`user@alias`).
fn ssh_alias(config: &str, names: &[String], user: &str, port: u16) -> Option<String> {
    #[derive(Default)]
    struct Block {
        aliases: Vec<String>,
        hostname: Option<String>,
        user: Option<String>,
        port: Option<u16>,
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut in_host = false;
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().trim_matches('"')),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                in_host = true;
                blocks.push(Block { aliases: value.split_whitespace().map(str::to_string).collect(), ..Default::default() });
            }
            "match" => in_host = false,
            _ if !in_host => {}
            // ssh uses the first value it sees for each option.
            "hostname" => {
                let b = blocks.last_mut().unwrap();
                b.hostname.get_or_insert_with(|| value.to_string());
            }
            "user" => {
                let b = blocks.last_mut().unwrap();
                b.user.get_or_insert_with(|| value.to_string());
            }
            "port" => {
                let b = blocks.last_mut().unwrap();
                if b.port.is_none() {
                    b.port = value.parse().ok();
                }
            }
            _ => {}
        }
    }
    blocks.iter().find_map(|b| {
        if b.user.as_deref().is_some_and(|u| u != user) || b.port.unwrap_or(22) != port {
            return None;
        }
        let alias = b.aliases.iter().find(|a| !a.contains(['*', '?', '!']))?;
        let target = norm(b.hostname.as_deref().unwrap_or(alias));
        names.contains(&target).then(|| if b.user.is_some() { alias.clone() } else { format!("{user}@{alias}") })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, user: &str) -> HostConfig {
        HostConfig::new(id, user)
    }

    fn peer(id: &str, dns: &str, ip: &str) -> TailnetPeer {
        TailnetPeer {
            id: id.into(),
            host_name: id.into(),
            dns_name: dns.into(),
            os: "linux".into(),
            ips: vec![ip.into()],
            online: true,
            ssh_host_keys: vec![],
            is_self: false,
        }
    }

    /// Machine-dependent: `cargo test -p consuls detects_vscode -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn detects_vscode_here() {
        let code = VsCode::detect().expect("VS Code installed");
        println!("{code:?}");
        assert!(code.exe.is_file());
    }

    /// Manual end-to-end (launches VS Code and a File Explorer window):
    /// `CHM_VSCODE_HOST=<machine> cargo test -p consuls launches_vscode -- --ignored --nocapture`.
    /// Opens this repo's README at 5:3, reveals it, and opens the machine's home over Remote-SSH,
    /// using the app's own config and the live tailnet for the authority.
    #[test]
    #[ignore]
    fn launches_vscode() {
        let host_id = std::env::var("CHM_VSCODE_HOST").unwrap_or_else(|_| "mbas-macbook-pro".into());
        assert!(!host_id.starts_with("spark"), "not on the Sparks: VS Code server would take memory they don't have");
        let code = VsCode::detect().expect("VS Code installed");
        let readme = Path::new(env!("CARGO_MANIFEST_DIR")).join("../README.md").canonicalize().unwrap();
        let readme = PathBuf::from(chm_core::local::to_slash(&readme).replace('/', std::path::MAIN_SEPARATOR_STR));
        code.open(&Target::Local { path: readme.clone(), line: Some(5), col: Some(3) }).unwrap();
        tauri_plugin_opener::reveal_item_in_dir(&readme).unwrap();

        let config_dir = Path::new(&std::env::var("APPDATA").unwrap()).join("dev.consuls.harness-manager/config.json");
        let config: chm_core::model::AppConfig = serde_json::from_str(&std::fs::read_to_string(config_dir).unwrap()).unwrap();
        let host = config.hosts.iter().find(|h| h.id == host_id).expect("machine configured");
        let tailnet = tokio::runtime::Runtime::new().unwrap().block_on(chm_core::tailscale::fetch_status());
        let peer = tailnet.peers.iter().find(|p| p.id == host_id);
        let ssh_config = std::fs::read_to_string(Path::new(&chm_core::local::home()).join(".ssh/config")).unwrap_or_default();
        let target = Target::Remote { authority: authority(host, peer, &ssh_config), path: format!("/Users/{}", host.user), line: None, col: None };
        println!("{:?}", args(&target));
        code.open(&target).unwrap();
    }

    #[test]
    fn remote_ssh_folder_names() {
        assert!(is_remote_ssh("ms-vscode-remote.remote-ssh-0.120.0"));
        assert!(!is_remote_ssh("ms-vscode-remote.remote-ssh-edit-0.87.0"));
        assert!(!is_remote_ssh("ms-vscode-remote.remote-wsl-0.99.0"));
    }

    #[test]
    fn prefers_an_ssh_config_alias() {
        let cfg = "\
# mine
Host spark
    HostName 192.168.1.20
    User consulear

Host box box-alias
  HostName box.tail1234.ts.net
  User someone-else

Host mac
  HostName MBAS-MacBook-Pro.tail1234.ts.net.

Host *
  ServerAliveInterval 30
";
        let p = peer("mbas-macbook-pro", "mbas-macbook-pro.tail1234.ts.net", "100.64.0.3");
        // Matches by MagicDNS name (case, trailing dot); the block has no User, so ours is added.
        assert_eq!(authority(&host("mbas-macbook-pro", "matt"), Some(&p), cfg), "matt@mac");
        // Matches by address, with the block's own user.
        let mut h = host("spark", "consulear");
        h.address = Some("192.168.1.20".into());
        assert_eq!(authority(&h, None, cfg), "spark");
        // A block for another user doesn't count.
        let p = peer("box", "box.tail1234.ts.net", "100.64.0.9");
        assert_eq!(authority(&host("box", "me"), Some(&p), cfg), "me@box.tail1234.ts.net");
    }

    #[test]
    fn falls_back_to_user_at_name() {
        let p = peer("spark-d683", "spark-d683.tail1234.ts.net", "100.64.0.2");
        assert_eq!(authority(&host("spark-d683", "consulear"), Some(&p), ""), "consulear@spark-d683.tail1234.ts.net");
        assert_eq!(authority(&host("spark-d683", "consulear"), None, ""), "consulear@spark-d683");
        // Non-standard port: Remote-SSH's hex-encoded JSON authority.
        let mut h = host("odd", "u");
        h.port = 2222;
        let hex = authority(&h, None, "");
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json, serde_json::json!({ "hostName": "odd", "user": "u", "port": 2222 }));
    }

    #[test]
    fn launch_arguments() {
        let local = Target::Local { path: PathBuf::from(r"D:\a b\x.rs"), line: Some(12), col: Some(3) };
        assert_eq!(args(&local), vec![OsString::from("--goto"), OsString::from(r"D:\a b\x.rs:12:3")]);
        let folder = Target::Local { path: PathBuf::from(r"D:\a b"), line: None, col: None };
        assert_eq!(args(&folder), vec![OsString::from(r"D:\a b")]);
        let remote = Target::Remote { authority: "u@h".into(), path: "/home/u/my proj".into(), line: None, col: None };
        assert_eq!(args(&remote), ["--remote", "ssh-remote+u@h", "/home/u/my proj"].map(OsString::from).to_vec());
        let remote = Target::Remote { authority: "h".into(), path: "/x/y.ts".into(), line: Some(4), col: None };
        assert_eq!(args(&remote), ["--remote", "ssh-remote+h", "--goto", "/x/y.ts:4"].map(OsString::from).to_vec());
    }
}
