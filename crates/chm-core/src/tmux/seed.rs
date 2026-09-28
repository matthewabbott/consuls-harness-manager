//! Rebuilding a pane's screen (and optionally its scrollback) from `capture-pane`.
//!
//! The seed runs as one command line so nothing happens in between: turn the pane's output
//! off for this client, capture, read the mode flags, turn output back on. Turning output
//! back on resumes from "now", so no byte is applied twice or lost (verified live under load).

use super::formats::{MODES_FORMAT, PaneModes, parse_modes};
use super::parser::{PaneId, Reply};
use super::quote::quote;

/// Builds the seed command line and returns it with the number of replies to expect.
///
/// With `history > 0` the scrollback is captured separately with `-J` (wrapped lines joined,
/// so they re-wrap naturally and copy as one line) and the visible screen without it (so each
/// row lands exactly where it was). `resume` is `on` for a fresh seed or `continue` after `%pause`.
pub fn seed_command(pane: PaneId, history: u32, resume: &str) -> (String, usize) {
    let target = quote(&format!("%{pane}"));
    let off = quote(&format!("%{pane}:off"));
    let on = quote(&format!("%{pane}:{resume}"));
    let modes = format!("display-message -p -t {target} {}", quote(MODES_FORMAT));
    if history > 0 {
        (
            format!(
                "refresh-client -A {off} ; capture-pane -p -e -J -t {target} -S -{history} -E -1 ; capture-pane -p -e -t {target} ; {modes} ; refresh-client -A {on}"
            ),
            5,
        )
    } else {
        (format!("refresh-client -A {off} ; capture-pane -p -e -t {target} ; {modes} ; refresh-client -A {on}"), 4)
    }
}

#[derive(Debug, Clone)]
pub struct Seed {
    /// Scrollback lines, oldest first (wrapped lines joined).
    pub history: Vec<Vec<u8>>,
    /// Exactly the visible rows.
    pub visible: Vec<Vec<u8>>,
    pub modes: PaneModes,
}

pub fn parse_seed(replies: &[Reply], with_history: bool) -> Option<Seed> {
    let (hist, vis, modes) = if with_history { (Some(1), 2, 3) } else { (None, 1, 2) };
    if replies.len() <= modes || !replies[vis].ok || !replies[modes].ok {
        return None;
    }
    let modes = parse_modes(&replies[modes].text())?;
    // With an empty history tmux returns visible line 0 for `-S -N -E -1`; ignore it.
    let history = match hist {
        Some(i) if replies[i].ok && modes.history_size > 0 => replies[i].lines.clone(),
        _ => Vec::new(),
    };
    Some(Seed { history, visible: replies[vis].lines.clone(), modes })
}

impl Seed {
    /// Bytes that recreate the pane on a terminal of the pane's size: history scrolls into
    /// scrollback, then every visible row is placed absolutely and cursor/modes restored.
    pub fn to_terminal_bytes(&self) -> Vec<u8> {
        let m = &self.modes;
        let height = m.height.max(1) as usize;
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(b"\x1bc"); // RIS: full reset
        if !self.history.is_empty() {
            for line in &self.history {
                out.extend_from_slice(line);
                out.extend_from_slice(b"\x1b[0m\r\n");
            }
            // Scroll every history row still on screen into scrollback.
            for _ in 1..height {
                out.extend_from_slice(b"\r\n");
            }
        }
        if m.alternate_on {
            out.extend_from_slice(b"\x1b[?1049h");
        }
        let visible = &self.visible[self.visible.len().saturating_sub(height)..];
        for (row, line) in visible.iter().enumerate() {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            out.extend_from_slice(line);
            out.extend_from_slice(b"\x1b[0m");
        }
        if m.scroll_upper != 0 || (m.scroll_lower as usize) + 1 != height {
            out.extend_from_slice(format!("\x1b[{};{}r", m.scroll_upper + 1, m.scroll_lower + 1).as_bytes());
        }
        if m.origin {
            out.extend_from_slice(b"\x1b[?6h");
        }
        let row = if m.origin { m.cursor_y.saturating_sub(m.scroll_upper) } else { m.cursor_y };
        out.extend_from_slice(format!("\x1b[{};{}H", row + 1, m.cursor_x + 1).as_bytes());
        if m.insert {
            out.extend_from_slice(b"\x1b[4h");
        }
        if !m.wrap {
            out.extend_from_slice(b"\x1b[?7l");
        }
        if m.keypad_cursor {
            out.extend_from_slice(b"\x1b[?1h");
        }
        if m.keypad {
            out.extend_from_slice(b"\x1b=");
        }
        if !m.cursor_visible {
            out.extend_from_slice(b"\x1b[?25l");
        }
        out
    }

    /// The same seed without scrollback (for the visible-only tile terminal).
    pub fn screen_only(&self) -> Seed {
        Seed { history: Vec::new(), visible: self.visible.clone(), modes: self.modes }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_shape() {
        let (cmd, n) = seed_command(3, 0, "on");
        assert_eq!(n, 4);
        assert!(cmd.starts_with("refresh-client -A '%3:off' ; capture-pane -p -e -t '%3' ; display-message -p -t '%3' '#{cursor_x}"));
        assert!(cmd.ends_with("; refresh-client -A '%3:on'"));
        let (cmd, n) = seed_command(3, 500, "continue");
        assert_eq!(n, 5);
        assert!(cmd.contains("capture-pane -p -e -J -t '%3' -S -500 -E -1 ; capture-pane -p -e -t '%3' ;"));
        assert!(cmd.ends_with("'%3:continue'"));
    }
}
