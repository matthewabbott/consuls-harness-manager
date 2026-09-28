//! Knowledge about the agent CLIs ("harnesses") we manage.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::integration::assets::Assets;
use crate::ssh::exec::sh_quote;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Harness {
    Claude,
    Codex,
    Omp,
    Pi,
    Opencode,
    Gemini,
    Shell,
}

impl Harness {
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "claude" => Harness::Claude,
            "codex" => Harness::Codex,
            "omp" => Harness::Omp,
            "pi" => Harness::Pi,
            "opencode" => Harness::Opencode,
            "gemini" => Harness::Gemini,
            "bash" | "zsh" | "fish" | "sh" | "dash" | "ksh" | "nu" | "tcsh" | "shell" => Harness::Shell,
            _ => return None,
        })
    }

    /// Best guess from what tmux tells us. An explicit `@chm_harness` tag (set when the app
    /// launched the pane) wins; otherwise the pane's foreground process name.
    pub fn detect(current_command: &str, tagged: Option<&str>) -> Option<Self> {
        if let Some(h) = tagged.and_then(Self::from_name)
            && (h == Harness::Shell || !Self::is_shell(current_command))
        {
            return Some(h);
        }
        Self::from_name(current_command.trim_start_matches('-'))
    }

    fn is_shell(cmd: &str) -> bool {
        matches!(Self::from_name(cmd.trim_start_matches('-')), Some(Harness::Shell))
    }

    pub fn name(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
            Harness::Omp => "omp",
            Harness::Pi => "pi",
            Harness::Opencode => "opencode",
            Harness::Gemini => "gemini",
            Harness::Shell => "shell",
        }
    }

    /// The shell command that starts this harness, with our hooks injected when `assets`
    /// are available. `None` for a plain shell.
    pub fn launch_command(self, assets: Option<&Assets>, extra_args: &str) -> Option<String> {
        self.launch_command_for(assets, extra_args, Quoting::Posix)
    }

    /// Like [`Harness::launch_command`], quoted for the shell it's typed into.
    pub fn launch_command_for(self, assets: Option<&Assets>, extra_args: &str, quoting: Quoting) -> Option<String> {
        let q = |s: &str| quoting.quote(s);
        let base = match (self, assets) {
            (Harness::Shell, _) => return None,
            (Harness::Claude, Some(a)) => format!("claude --settings {}", q(&a.claude_settings)),
            // cmd.exe can't pass the JSON-ish array intact; those sessions use heuristics.
            (Harness::Codex, Some(a)) if quoting != Quoting::Cmd => {
                let notify = format!("notify=[\"{}\",\"{}\",\"codex\",\"Stop\"]", a.sh, a.hook);
                format!("codex -c {}", q(&notify))
            }
            (Harness::Omp, Some(a)) => format!("omp --hook {}", q(&a.omp_extension)),
            (h, _) => h.name().to_string(),
        };
        let extra = extra_args.trim();
        Some(if extra.is_empty() { base } else { format!("{base} {extra}") })
    }

    /// What to type to make the harness exit gracefully.
    pub fn quit_command(self) -> Option<&'static str> {
        match self {
            Harness::Claude | Harness::Omp | Harness::Opencode => Some("/exit"),
            Harness::Codex | Harness::Pi | Harness::Gemini => Some("/quit"),
            Harness::Shell => None,
        }
    }
}

/// Programs whose bell means "someone wants you" (IRC/chat clients). Shells beep on failed
/// tab completion, so bells elsewhere only ping when the user turns it on for the pane.
pub fn bell_pings_by_default(current_command: &str) -> bool {
    matches!(current_command, "irssi" | "weechat" | "senpai" | "catgirl" | "profanity" | "finch" | "gomuks")
}

/// Effective bell setting for a pane.
pub fn bell_pings(explicit: Option<bool>, current_command: &str) -> bool {
    explicit.unwrap_or_else(|| bell_pings_by_default(current_command))
}

/// How to quote one argument for the shell a command is typed into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quoting {
    Posix,
    PowerShell,
    Cmd,
}

impl Quoting {
    pub fn quote(self, s: &str) -> String {
        match self {
            Quoting::Posix => sh_quote(s),
            Quoting::PowerShell => format!("'{}'", s.replace('\'', "''")),
            Quoting::Cmd => format!("\"{s}\""),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection() {
        assert_eq!(Harness::detect("omp", None), Some(Harness::Omp));
        assert_eq!(Harness::detect("-bash", None), Some(Harness::Shell));
        assert_eq!(Harness::detect("node", None), None);
        // An app-launched claude pane whose harness exited back to the shell reads as a shell.
        assert_eq!(Harness::detect("bash", Some("claude")), Some(Harness::Shell));
        assert_eq!(Harness::detect("node", Some("codex")), Some(Harness::Codex));
    }

    #[test]
    fn launch_commands_inject_hooks() {
        let a = Assets::at("/home/u");
        assert_eq!(
            Harness::Claude.launch_command(Some(&a), "--model opus").unwrap(),
            "claude --settings '/home/u/.local/share/consuls/claude-settings.json' --model opus"
        );
        assert_eq!(
            Harness::Codex.launch_command(Some(&a), "").unwrap(),
            "codex -c 'notify=[\"sh\",\"/home/u/.local/share/consuls/chm-hook.sh\",\"codex\",\"Stop\"]'"
        );
        assert_eq!(Harness::Omp.launch_command(None, "").unwrap(), "omp");
        assert_eq!(Harness::Shell.launch_command(Some(&a), ""), None);
        assert_eq!(Harness::Codex.quit_command(), Some("/quit"));
        let w = Assets::with_sh("C:/Users/A B", "D:/Git/usr/bin/sh.exe");
        assert_eq!(
            Harness::Claude.launch_command_for(Some(&w), "", Quoting::PowerShell).unwrap(),
            "claude --settings 'C:/Users/A B/.local/share/consuls/claude-settings.json'"
        );
        assert_eq!(
            Harness::Codex.launch_command_for(Some(&w), "", Quoting::PowerShell).unwrap(),
            "codex -c 'notify=[\"D:/Git/usr/bin/sh.exe\",\"C:/Users/A B/.local/share/consuls/chm-hook.sh\",\"codex\",\"Stop\"]'"
        );
        assert_eq!(Harness::Codex.launch_command_for(Some(&w), "", Quoting::Cmd).unwrap(), "codex");
        assert_eq!(
            Harness::Omp.launch_command_for(Some(&w), "", Quoting::Cmd).unwrap(),
            "omp --hook \"C:/Users/A B/.local/share/consuls/omp-extension.ts\""
        );
    }
}
