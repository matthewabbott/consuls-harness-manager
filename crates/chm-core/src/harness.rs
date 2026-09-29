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

/// One step of sending a composer prompt to a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PromptStep {
    /// A bracketed paste (plain text when the program didn't ask for bracketed paste).
    Paste(String),
    WaitMs(u64),
    Enter,
}

/// A path pasted on its own, as agents recognise one: Windows paths as they are (Codex takes
/// `C:/…` literally), others shell-quoted when they contain spaces or quotes (Codex splits
/// those like a shell).
pub(crate) fn pasted_path(path: &str) -> String {
    let b = path.as_bytes();
    let windows = b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\');
    if windows || !path.contains(|c: char| c.is_whitespace() || c == '\'' || c == '"') { path.to_string() } else { sh_quote(path) }
}

/// How to send a composer prompt with images already saved on the pane's machine.
///
/// Claude Code and Codex turn a paste that is only an image's path into an attachment, so
/// each image goes as its own paste before the text. Claude Code reads the image
/// asynchronously and drops an Enter that arrives meanwhile, hence the longer wait. Other
/// programs get the paths at the end of the text.
///
/// The pause before Enter matters too: Codex treats keystrokes arriving within ~120 ms of a
/// paste burst as part of the paste, and Claude Code needs a beat to collapse large pastes.
pub(crate) fn prompt_steps(text: &str, images: &[String], harness: Option<Harness>) -> Vec<PromptStep> {
    let mut text = text.trim_end_matches(['\n', '\r']).to_string();
    let mut steps = Vec::new();
    if matches!(harness, Some(Harness::Claude | Harness::Codex)) {
        for path in images {
            steps.push(PromptStep::Paste(pasted_path(path)));
            steps.push(PromptStep::WaitMs(150));
        }
        if !images.is_empty() && harness == Some(Harness::Claude) {
            steps.push(PromptStep::WaitMs(850));
        }
    } else if !images.is_empty() {
        let quoted: Vec<String> = images.iter().map(|p| if p.contains([' ', '\'', '"']) { sh_quote(p) } else { p.clone() }).collect();
        // After the text, as arguments (`file <image>` in a shell).
        text = if text.is_empty() { quoted.join(" ") } else { format!("{text} {}", quoted.join(" ")) };
    }
    if text.trim().is_empty() && images.is_empty() {
        return Vec::new();
    }
    let settle = match harness {
        Some(Harness::Codex) => 350,
        _ if text.len() > 800 || text.contains('\n') => 300,
        _ => 180,
    };
    if !text.is_empty() {
        steps.push(PromptStep::Paste(text));
    }
    steps.push(PromptStep::WaitMs(settle));
    steps.push(PromptStep::Enter);
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::PromptStep::{Enter, Paste, WaitMs};

    #[test]
    fn prompts_with_images() {
        let imgs = vec!["/h/.cache/consuls/pastes/paste-1-a.png".to_string(), "C:/Users/A B/p.png".to_string()];
        assert_eq!(prompt_steps("hi\n", &[], Some(Harness::Claude)), [Paste("hi".into()), WaitMs(180), Enter]);
        assert_eq!(prompt_steps(" \n", &[], None), []);
        assert_eq!(
            prompt_steps("what's this?", &imgs, Some(Harness::Claude)),
            [Paste(imgs[0].clone()), WaitMs(150), Paste(imgs[1].clone()), WaitMs(150), WaitMs(850), Paste("what's this?".into()), WaitMs(180), Enter]
        );
        assert_eq!(prompt_steps("", &imgs[..1], Some(Harness::Codex)), [Paste(imgs[0].clone()), WaitMs(150), WaitMs(350), Enter]);
        assert_eq!(pasted_path("/home/a b/p.png"), "'/home/a b/p.png'");
        assert_eq!(pasted_path("C:/Users/A B/p.png"), "C:/Users/A B/p.png");
        assert_eq!(
            prompt_steps("look", &imgs, Some(Harness::Shell)),
            [Paste("look /h/.cache/consuls/pastes/paste-1-a.png 'C:/Users/A B/p.png'".into()), WaitMs(180), Enter]
        );
    }

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
