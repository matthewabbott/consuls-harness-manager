//! Byte-level parser for tmux control mode (`tmux -C`).
//!
//! The stream is a sequence of `\n`-terminated lines. Command replies are wrapped in
//! `%begin <time> <number> <flags>` … `%end|%error <time> <number> <flags>`; the lines in
//! between are raw command output (not escaped), so a line that merely *looks* like `%end`
//! only closes the block when all three fields match. Everything else starting with `%` is a
//! notification. `%output` data escapes bytes < 0x20 and `\` as `\ooo` octal.
//!
//! Anything before the first `%` line (login-shell noise: motd, conda, …) is surfaced as
//! [`Event::Noise`] and otherwise ignored.

use memchr::memchr;

/// A tmux pane id (`%12` → 12).
pub type PaneId = u32;
/// A tmux window id (`@3` → 3).
pub type WindowId = u32;
/// A tmux session id (`$1` → 1).
pub type SessionId = u32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub time: i64,
    pub number: u32,
    /// 1 when the command came from this client; 0 for e.g. the initial `attach`.
    pub flags: u32,
    /// `false` for `%error` blocks.
    pub ok: bool,
    pub lines: Vec<Vec<u8>>,
}

impl Reply {
    pub fn from_this_client(&self) -> bool {
        self.flags & 1 == 1
    }

    pub fn text(&self) -> String {
        let mut out = String::new();
        for (i, line) in self.lines.iter().enumerate() {
            if i > 0 {
                out.push('\n');
            }
            out.push_str(&String::from_utf8_lossy(line));
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Reply(Reply),
    /// Decoded pane output (from `%output` or `%extended-output`).
    Output { pane: PaneId, data: Vec<u8> },
    Pause { pane: PaneId },
    Continue { pane: PaneId },
    WindowAdd { window: WindowId },
    WindowClose { window: WindowId },
    WindowRenamed { window: WindowId, name: String },
    UnlinkedWindowAdd { window: WindowId },
    UnlinkedWindowClose { window: WindowId },
    UnlinkedWindowRenamed { window: WindowId },
    LayoutChange { window: WindowId, layout: String },
    WindowPaneChanged { window: WindowId, pane: PaneId },
    PaneModeChanged { pane: PaneId },
    SessionsChanged,
    SessionChanged { session: SessionId, name: String },
    SessionRenamed { name: String },
    SessionWindowChanged { session: SessionId, window: WindowId },
    ClientSessionChanged { client: String, session: SessionId, name: String },
    ClientDetached { client: String },
    SubscriptionChanged { name: String, pane: Option<PaneId>, value: String },
    PasteBufferChanged { name: String },
    PasteBufferDeleted { name: String },
    Message(String),
    ConfigError(String),
    Exit { reason: Option<String> },
    /// A `%` line we don't recognise (newer tmux).
    Unknown(Vec<u8>),
    /// A non-`%` line outside a reply block.
    Noise(Vec<u8>),
}

#[derive(Debug, Default)]
pub struct Parser {
    buf: Vec<u8>,
    block: Option<(i64, u32, u32)>,
    block_lines: Vec<Vec<u8>>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds raw bytes from the channel; returns every complete event.
    pub fn feed(&mut self, data: &[u8]) -> Vec<Event> {
        self.buf.extend_from_slice(data);
        let mut events = Vec::new();
        let mut start = 0;
        while let Some(rel) = memchr(b'\n', &self.buf[start..]) {
            let end = start + rel;
            let line = self.buf[start..end].to_vec();
            start = end + 1;
            if let Some(ev) = self.line(line) {
                events.push(ev);
            }
        }
        self.buf.drain(..start);
        events
    }

    fn line(&mut self, line: Vec<u8>) -> Option<Event> {
        if let Some((time, number, flags)) = self.block {
            for (guard, ok) in [(&b"%end "[..], true), (&b"%error "[..], false)] {
                if let Some(rest) = line.strip_prefix(guard)
                    && parse_guard(rest) == Some((time, number, flags))
                {
                    self.block = None;
                    return Some(Event::Reply(Reply {
                        time,
                        number,
                        flags,
                        ok,
                        lines: std::mem::take(&mut self.block_lines),
                    }));
                }
            }
            self.block_lines.push(line);
            return None;
        }

        if let Some(rest) = line.strip_prefix(b"%begin ")
            && let Some(guard) = parse_guard(rest)
        {
            self.block = Some(guard);
            self.block_lines.clear();
            return None;
        }
        if line.first() == Some(&b'%') {
            return Some(parse_notification(&line));
        }
        Some(Event::Noise(line))
    }
}

fn parse_guard(rest: &[u8]) -> Option<(i64, u32, u32)> {
    let s = std::str::from_utf8(rest).ok()?;
    let mut it = s.split(' ');
    let time = it.next()?.parse().ok()?;
    let number = it.next()?.parse().ok()?;
    let flags = it.next()?.trim_end_matches('\r').parse().ok()?;
    Some((time, number, flags))
}

fn id_with(prefix: u8, word: &[u8]) -> Option<u32> {
    let digits = word.strip_prefix(&[prefix])?;
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// Splits off the first space-separated word.
fn word(s: &[u8]) -> (&[u8], &[u8]) {
    match memchr(b' ', s) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, &[]),
    }
}

fn lossy(s: &[u8]) -> String {
    String::from_utf8_lossy(s).into_owned()
}

/// Returns what follows the first ` : ` separator (used by `%extended-output` and
/// `%subscription-changed`).
fn after_colon(s: &[u8]) -> Option<&[u8]> {
    memchr::memmem::find(s, b" : ").map(|i| &s[i + 3..])
}

/// Decodes tmux's `\ooo` octal escapes.
pub fn unescape(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b == b'\\' && i + 4 <= data.len() {
            let oct = &data[i + 1..i + 4];
            if oct.iter().all(|c| (b'0'..=b'7').contains(c)) {
                let v = (oct[0] - b'0') as u16 * 64 + (oct[1] - b'0') as u16 * 8 + (oct[2] - b'0') as u16;
                out.push(v as u8);
                i += 4;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    out
}

fn parse_notification(line: &[u8]) -> Event {
    let (name, rest) = word(line);
    let unknown = || Event::Unknown(line.to_vec());
    match name {
        b"%output" => {
            let (pane, data) = word(rest);
            match id_with(b'%', pane) {
                Some(pane) => Event::Output { pane, data: unescape(data) },
                None => unknown(),
            }
        }
        b"%extended-output" => {
            let (pane, tail) = word(rest);
            match (id_with(b'%', pane), after_colon(tail)) {
                (Some(pane), Some(data)) => Event::Output { pane, data: unescape(data) },
                _ => unknown(),
            }
        }
        b"%pause" => id_with(b'%', word(rest).0).map_or_else(unknown, |pane| Event::Pause { pane }),
        b"%continue" => {
            id_with(b'%', word(rest).0).map_or_else(unknown, |pane| Event::Continue { pane })
        }
        b"%window-add" => {
            id_with(b'@', word(rest).0).map_or_else(unknown, |window| Event::WindowAdd { window })
        }
        b"%window-close" => {
            id_with(b'@', word(rest).0).map_or_else(unknown, |window| Event::WindowClose { window })
        }
        b"%window-renamed" => {
            let (w, name) = word(rest);
            id_with(b'@', w)
                .map_or_else(unknown, |window| Event::WindowRenamed { window, name: lossy(name) })
        }
        b"%unlinked-window-add" => id_with(b'@', word(rest).0)
            .map_or_else(unknown, |window| Event::UnlinkedWindowAdd { window }),
        b"%unlinked-window-close" => id_with(b'@', word(rest).0)
            .map_or_else(unknown, |window| Event::UnlinkedWindowClose { window }),
        b"%unlinked-window-renamed" => id_with(b'@', word(rest).0)
            .map_or_else(unknown, |window| Event::UnlinkedWindowRenamed { window }),
        b"%layout-change" => {
            let (w, tail) = word(rest);
            let (layout, _) = word(tail);
            id_with(b'@', w)
                .map_or_else(unknown, |window| Event::LayoutChange { window, layout: lossy(layout) })
        }
        b"%window-pane-changed" => {
            let (w, p) = word(rest);
            match (id_with(b'@', w), id_with(b'%', word(p).0)) {
                (Some(window), Some(pane)) => Event::WindowPaneChanged { window, pane },
                _ => unknown(),
            }
        }
        b"%pane-mode-changed" => {
            id_with(b'%', word(rest).0).map_or_else(unknown, |pane| Event::PaneModeChanged { pane })
        }
        b"%sessions-changed" => Event::SessionsChanged,
        b"%session-changed" => {
            let (s, name) = word(rest);
            id_with(b'$', s)
                .map_or_else(unknown, |session| Event::SessionChanged { session, name: lossy(name) })
        }
        b"%session-renamed" => Event::SessionRenamed { name: lossy(rest) },
        b"%session-window-changed" => {
            let (s, w) = word(rest);
            match (id_with(b'$', s), id_with(b'@', word(w).0)) {
                (Some(session), Some(window)) => Event::SessionWindowChanged { session, window },
                _ => unknown(),
            }
        }
        b"%client-session-changed" => {
            let (client, tail) = word(rest);
            let (s, name) = word(tail);
            id_with(b'$', s).map_or_else(unknown, |session| Event::ClientSessionChanged {
                client: lossy(client),
                session,
                name: lossy(name),
            })
        }
        b"%client-detached" => Event::ClientDetached { client: lossy(rest) },
        b"%subscription-changed" => {
            // %subscription-changed <name> $session @window <index> %pane … : <value>
            let (name, tail) = word(rest);
            let value = after_colon(tail).map(lossy).unwrap_or_default();
            let pane = tail
                .split(|b| *b == b' ')
                .take_while(|w| *w != b":")
                .find_map(|w| id_with(b'%', w));
            Event::SubscriptionChanged { name: lossy(name), pane, value }
        }
        b"%paste-buffer-changed" => Event::PasteBufferChanged { name: lossy(rest) },
        b"%paste-buffer-deleted" => Event::PasteBufferDeleted { name: lossy(rest) },
        b"%message" => Event::Message(lossy(rest)),
        b"%config-error" => Event::ConfigError(lossy(rest)),
        b"%exit" => Event::Exit { reason: Some(lossy(rest)).filter(|r| !r.is_empty()) },
        _ => unknown(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded from tmux 3.4 on spark2 (private socket), lightly trimmed.
    const RECORDED: &[u8] = b"Welcome to Ubuntu\n\
%begin 1790550099 268 0\n\
%end 1790550099 268 0\n\
%session-changed $0 probe\n\
%begin 1790550099 273 1\n\
%0 80x24 \n\
%end 1790550099 273 1\n\
%extended-output %0 0 : bs\\134 \xc3\xa9 \xe6\x97\xa5\\015\\012\\033[?2004hbash-5.2$ \n\
%begin 1790550100 276 1\n\
hello\n\
%end 1790550100 276 1\n\
%begin 1790550100 278 1\n\
parse error: unknown command: bogus-command\n\
%error 1790550100 278 1\n\
%window-add @1\n\
%begin 1790550103 282 1\n\
%end 1790550103 999 1\n\
%end 1790550103 282\n\
\n\
%end 1790550103 282 1\n\
%subscription-changed test $0 @1 0 %1 : bash\n\
%layout-change @1 b25d,80x24,0,0,1 b25d,80x24,0,0,1 *\n\
%exit\n";

    #[test]
    fn parses_recorded_session() {
        let evs = Parser::new().feed(RECORDED);
        assert_eq!(evs[0], Event::Noise(b"Welcome to Ubuntu".to_vec()));
        let Event::Reply(initial) = &evs[1] else { panic!("{:?}", evs[1]) };
        assert!(!initial.from_this_client() && initial.lines.is_empty());
        assert_eq!(evs[2], Event::SessionChanged { session: 0, name: "probe".into() });
        let Event::Reply(r) = &evs[3] else { panic!() };
        assert!(r.ok && r.from_this_client());
        assert_eq!(r.text(), "%0 80x24 ");
        assert_eq!(
            evs[4],
            Event::Output {
                pane: 0,
                data: b"bs\\ \xc3\xa9 \xe6\x97\xa5\r\n\x1b[?2004hbash-5.2$ ".to_vec()
            }
        );
        let Event::Reply(hello) = &evs[5] else { panic!() };
        assert_eq!(hello.text(), "hello");
        let Event::Reply(err) = &evs[6] else { panic!() };
        assert!(!err.ok);
        assert_eq!(evs[7], Event::WindowAdd { window: 1 });
        // Fake %end lines inside the block (wrong number / missing flags) are content.
        let Event::Reply(cap) = &evs[8] else { panic!() };
        assert_eq!(cap.lines.len(), 3);
        assert_eq!(cap.lines[0], b"%end 1790550103 999 1");
        assert_eq!(
            evs[9],
            Event::SubscriptionChanged { name: "test".into(), pane: Some(1), value: "bash".into() }
        );
        assert_eq!(
            evs[10],
            Event::LayoutChange { window: 1, layout: "b25d,80x24,0,0,1".into() }
        );
        assert_eq!(evs[11], Event::Exit { reason: None });
        assert_eq!(evs.len(), 12);
    }

    #[test]
    fn handles_arbitrary_chunking() {
        let whole = Parser::new().feed(RECORDED);
        for chunk in [1, 2, 3, 7, 64] {
            let mut p = Parser::new();
            let mut evs = Vec::new();
            for c in RECORDED.chunks(chunk) {
                evs.extend(p.feed(c));
            }
            assert_eq!(evs, whole, "chunk size {chunk}");
        }
    }

    #[test]
    fn unescape_edge_cases() {
        assert_eq!(unescape(b"a\\134b"), b"a\\b");
        assert_eq!(unescape(b"\\033[0m\\015\\012"), b"\x1b[0m\r\n");
        // Incomplete or non-octal escapes pass through untouched.
        assert_eq!(unescape(b"x\\9"), b"x\\9");
        assert_eq!(unescape(b"x\\01"), b"x\\01");
        assert_eq!(unescape(b"\\"), b"\\");
    }

    #[test]
    fn plain_output_notification() {
        let evs = Parser::new().feed(b"%output %12 hi\\040there\\012\n%pause %12\n%continue %12\n");
        assert_eq!(evs[0], Event::Output { pane: 12, data: b"hi there\n".to_vec() });
        assert_eq!(evs[1], Event::Pause { pane: 12 });
        assert_eq!(evs[2], Event::Continue { pane: 12 });
    }
}
