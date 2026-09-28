//! Per-pane terminal state (alacritty_terminal) and the compact snapshot encoding the
//! frontend paints mini tiles from.
//!
//! tmux panes keep only the visible screen (tmux has the history). Direct panes keep their
//! own scrollback, answer terminal queries through an [`EventListener`], and can be
//! [serialized](TileTerm::serialize) to rebuild an expanded view from scratch.

use std::sync::{Arc, Mutex};

use alacritty_terminal::Term;
use alacritty_terminal::event::{Event, EventListener, VoidListener};
use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb, StdSyncHandler};

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TileTerm<L: EventListener = VoidListener> {
    term: Term<L>,
    parser: Processor<StdSyncHandler>,
    cols: u16,
    rows: u16,
}

impl TileTerm<VoidListener> {
    /// Visible screen only, no replies (tmux panes).
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_listener(cols, rows, 0, VoidListener)
    }
}

/// Collects what a terminal asks of its host (query replies, title, bell, ...).
#[derive(Clone, Default)]
pub struct Collector(Arc<Mutex<Vec<Event>>>);

impl EventListener for Collector {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup | Event::MouseCursorDirty | Event::CursorBlinkingChange => {}
            other => self.0.lock().unwrap().push(other),
        }
    }
}

impl Collector {
    pub fn drain(&self) -> Vec<Event> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl<L: EventListener> TileTerm<L> {
    pub fn with_listener(cols: u16, rows: u16, history: usize, listener: L) -> Self {
        let size = Size { cols: cols.max(1) as usize, rows: rows.max(1) as usize };
        let config = Config { scrolling_history: history, ..Config::default() };
        Self { term: Term::new(config, &size, listener), parser: Processor::new(), cols, rows }
    }

    pub fn mode(&self) -> TermMode {
        *self.term.mode()
    }

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if (cols, rows) != (self.cols, self.rows) {
            self.cols = cols;
            self.rows = rows;
            self.term.resize(Size { cols: cols.max(1) as usize, rows: rows.max(1) as usize });
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// Plain text of the visible screen (used for screen-regex attention fallbacks and tests).
    pub fn text(&self) -> String {
        let grid = self.term.grid();
        let mut out = String::new();
        for row in 0..grid.screen_lines() {
            let line = &grid[Line(row as i32)];
            let mut s = String::new();
            for col in 0..grid.columns() {
                let cell = &line[Column(col)];
                if !cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    s.push(cell.c);
                }
            }
            out.push_str(s.trim_end());
            out.push('\n');
        }
        out
    }

    /// Encodes the visible screen as styled runs. Layout (little-endian):
    /// `cols u16, rows u16, cursor_x u16, cursor_y u16, flags u8` then per row
    /// `run_count u16` and per run `start_col u16, cells u16, fg u32, bg u32, attrs u16,
    /// text_len u16, text (utf-8)`.
    pub fn snapshot(&self) -> Vec<u8> {
        let grid = self.term.grid();
        let mode = self.term.mode();
        let cursor = grid.cursor.point;
        let mut out = Vec::with_capacity(self.cols as usize * self.rows as usize / 2 + 64);
        put_u16(&mut out, self.cols);
        put_u16(&mut out, self.rows);
        put_u16(&mut out, cursor.column.0 as u16);
        put_u16(&mut out, cursor.line.0.max(0) as u16);
        let mut flags = 0u8;
        if mode.contains(TermMode::SHOW_CURSOR) {
            flags |= 1;
        }
        if mode.contains(TermMode::ALT_SCREEN) {
            flags |= 2;
        }
        out.push(flags);

        for row in 0..grid.screen_lines() {
            let line = &grid[Line(row as i32)];
            let cols = grid.columns();
            // Drop trailing blank default-background cells.
            let mut end = cols;
            while end > 0 {
                let c = &line[Column(end - 1)];
                let blank = (c.c == ' ' || c.flags.contains(Flags::WIDE_CHAR_SPACER))
                    && encode_color(c.bg, true) == 0
                    && !c.flags.contains(Flags::INVERSE);
                if !blank {
                    break;
                }
                end -= 1;
            }

            let count_pos = out.len();
            put_u16(&mut out, 0);
            let mut runs = 0u16;
            let mut col = 0;
            while col < end {
                let first = &line[Column(col)];
                let key = (encode_color(first.fg, false), encode_color(first.bg, true), attrs(first.flags));
                let start = col;
                let mut text = String::new();
                while col < end {
                    let c = &line[Column(col)];
                    if (encode_color(c.fg, false), encode_color(c.bg, true), attrs(c.flags)) != key {
                        break;
                    }
                    if !c.flags.contains(Flags::WIDE_CHAR_SPACER) {
                        text.push(if c.c == '\0' { ' ' } else { c.c });
                    }
                    col += 1;
                }
                put_u16(&mut out, start as u16);
                put_u16(&mut out, (col - start) as u16);
                put_u32(&mut out, key.0);
                put_u32(&mut out, key.1);
                put_u16(&mut out, key.2);
                let bytes = text.as_bytes();
                put_u16(&mut out, bytes.len() as u16);
                out.extend_from_slice(bytes);
                runs += 1;
            }
            out[count_pos..count_pos + 2].copy_from_slice(&runs.to_le_bytes());
        }
        out
    }

    /// Bytes that rebuild this terminal (scrollback, screen, cursor and modes) on a fresh
    /// terminal of the same size. Wrapped rows are written through, so the receiving terminal
    /// knows they're one logical line (reflow, copy). While an app is on the alternate screen
    /// only that screen is available.
    pub fn serialize(&self) -> Vec<u8> {
        let grid = self.term.grid();
        let mode = *self.term.mode();
        let cols = grid.columns();
        let alt = mode.contains(TermMode::ALT_SCREEN);
        let mut out: Vec<u8> = Vec::with_capacity((grid.history_size() + grid.screen_lines()) * 48);
        out.extend_from_slice(b"\x1bc");
        if alt {
            out.extend_from_slice(b"\x1b[?1049h\x1b[H");
        }
        let top = if alt { 0 } else { -(grid.history_size() as i32) };
        let bottom = grid.screen_lines() as i32 - 1;
        for l in top..=bottom {
            let row = &grid[Line(l)];
            let wrapped = cols > 0 && row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
            write_row(&mut out, row, cols, wrapped);
            if l != bottom && !wrapped {
                out.extend_from_slice(b"\r\n");
            }
        }
        let cursor = grid.cursor.point;
        out.extend_from_slice(format!("\x1b[{};{}H", cursor.line.0.max(0) + 1, cursor.column.0 + 1).as_bytes());
        let flags: [(TermMode, &[u8]); 12] = [
            (TermMode::APP_CURSOR, b"\x1b[?1h"),
            (TermMode::APP_KEYPAD, b"\x1b="),
            (TermMode::BRACKETED_PASTE, b"\x1b[?2004h"),
            (TermMode::MOUSE_REPORT_CLICK, b"\x1b[?1000h"),
            (TermMode::MOUSE_DRAG, b"\x1b[?1002h"),
            (TermMode::MOUSE_MOTION, b"\x1b[?1003h"),
            (TermMode::UTF8_MOUSE, b"\x1b[?1005h"),
            (TermMode::SGR_MOUSE, b"\x1b[?1006h"),
            (TermMode::FOCUS_IN_OUT, b"\x1b[?1004h"),
            (TermMode::ALTERNATE_SCROLL, b"\x1b[?1007h"),
            (TermMode::INSERT, b"\x1b[4h"),
            (TermMode::LINE_FEED_NEW_LINE, b"\x1b[20h"),
        ];
        for (flag, seq) in flags {
            if mode.contains(flag) {
                out.extend_from_slice(seq);
            }
        }
        if !mode.contains(TermMode::LINE_WRAP) {
            out.extend_from_slice(b"\x1b[?7l");
        }
        if !mode.contains(TermMode::SHOW_CURSOR) {
            out.extend_from_slice(b"\x1b[?25l");
        }
        out
    }
}

/// Writes one grid row as SGR-styled text. Rows that wrap are written in full (so the
/// receiving terminal wraps too); others drop trailing default blanks.
fn write_row(out: &mut Vec<u8>, row: &Row<Cell>, cols: usize, wrapped: bool) {
    let mut end = cols;
    if !wrapped {
        while end > 0 {
            let c = &row[Column(end - 1)];
            let blank = (c.c == ' ' || c.c == '\0' || c.flags.contains(Flags::WIDE_CHAR_SPACER))
                && c.bg == Color::Named(NamedColor::Background)
                && !c.flags.intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
            if !blank {
                break;
            }
            end -= 1;
        }
    }
    let mut pen: Option<(Color, Color, Flags)> = None;
    let mut buf = [0u8; 4];
    for col in 0..end {
        let c = &row[Column(col)];
        if c.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let style = (c.fg, c.bg, c.flags & STYLE_FLAGS);
        if pen != Some(style) {
            out.extend_from_slice(sgr(c).as_bytes());
            pen = Some(style);
        }
        let ch = if c.c == '\0' { ' ' } else { c.c };
        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        if let Some(extra) = c.zerowidth() {
            for z in extra {
                out.extend_from_slice(z.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    if pen.is_some() {
        out.extend_from_slice(b"\x1b[0m");
    }
}

const STYLE_FLAGS: Flags = Flags::BOLD
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::DIM)
    .union(Flags::STRIKEOUT)
    .union(Flags::HIDDEN);

/// A full SGR sequence (starting from a reset) for the cell's style.
fn sgr(c: &Cell) -> String {
    let mut p: Vec<String> = vec!["0".into()];
    let f = c.flags;
    if f.contains(Flags::BOLD) {
        p.push("1".into());
    }
    if f.contains(Flags::DIM) {
        p.push("2".into());
    }
    if f.contains(Flags::ITALIC) {
        p.push("3".into());
    }
    if f.contains(Flags::DOUBLE_UNDERLINE) {
        p.push("4:2".into());
    } else if f.contains(Flags::UNDERCURL) {
        p.push("4:3".into());
    } else if f.contains(Flags::DOTTED_UNDERLINE) {
        p.push("4:4".into());
    } else if f.contains(Flags::DASHED_UNDERLINE) {
        p.push("4:5".into());
    } else if f.intersects(Flags::ALL_UNDERLINES) {
        p.push("4".into());
    }
    if f.contains(Flags::INVERSE) {
        p.push("7".into());
    }
    if f.contains(Flags::HIDDEN) {
        p.push("8".into());
    }
    if f.contains(Flags::STRIKEOUT) {
        p.push("9".into());
    }
    if let Some(s) = color_sgr(c.fg, false) {
        p.push(s);
    }
    if let Some(s) = color_sgr(c.bg, true) {
        p.push(s);
    }
    format!("\x1b[{}m", p.join(";"))
}

fn color_sgr(c: Color, bg: bool) -> Option<String> {
    let (base, bright, ext) = if bg { (40, 100, 48) } else { (30, 90, 38) };
    match c {
        Color::Spec(rgb) => Some(format!("{ext};2;{};{};{}", rgb.r, rgb.g, rgb.b)),
        Color::Indexed(i) => Some(format!("{ext};5;{i}")),
        Color::Named(n) => {
            let idx = match n {
                NamedColor::Foreground | NamedColor::Background | NamedColor::Cursor | NamedColor::DimForeground => return None,
                NamedColor::BrightForeground => 15,
                n if (n as usize) < 16 => n as usize,
                // Dim variants: the dim attribute is carried separately, use the normal colour.
                n => (n as usize).saturating_sub(NamedColor::DimBlack as usize).min(7),
            };
            Some(if idx < 8 { format!("{}", base + idx) } else { format!("{}", bright + idx - 8) })
        }
    }
}

/// The UI's terminal palette (src/term/palette.ts), for answering colour queries (OSC 4/10/11/12).
pub fn palette_rgb(index: usize) -> Rgb {
    const ANSI: [u32; 16] = [
        0x1c2130, 0xf07178, 0xa6d189, 0xe5c07b, 0x7aa2f7, 0xc792ea, 0x7fdbca, 0xc9d1e3, 0x5c6680, 0xff8b92, 0xb9e39a,
        0xf2d38f, 0x9ab8ff, 0xd7a8f5, 0x9eeadb, 0xeef1f8,
    ];
    let hex = |v: u32| Rgb { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 };
    match index {
        0..=15 => hex(ANSI[index]),
        16..=231 => {
            let i = index - 16;
            let step = |v: usize| if v == 0 { 0 } else { (55 + v * 40) as u8 };
            Rgb { r: step(i / 36), g: step((i / 6) % 6), b: step(i % 6) }
        }
        232..=255 => {
            let v = (8 + (index - 232) * 10) as u8;
            Rgb { r: v, g: v, b: v }
        }
        256 => hex(0xc9d1e3), // foreground
        258 => hex(0xf5a25d), // cursor
        _ => hex(0x0e1119),   // background (257) and anything else
    }
}

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// `0` = default colour; `0x0100_00NN` = palette index NN; `0x02RR_GGBB` = true colour.
fn encode_color(c: Color, _is_bg: bool) -> u32 {
    match c {
        Color::Spec(rgb) => 0x0200_0000 | (rgb.r as u32) << 16 | (rgb.g as u32) << 8 | rgb.b as u32,
        Color::Indexed(i) => 0x0100_0000 | i as u32,
        Color::Named(n) => {
            let idx = n as usize;
            if idx < 16 {
                0x0100_0000 | idx as u32
            } else {
                match n {
                    NamedColor::DimBlack => 0x0100_0000,
                    NamedColor::DimRed => 0x0100_0001,
                    NamedColor::DimGreen => 0x0100_0002,
                    NamedColor::DimYellow => 0x0100_0003,
                    NamedColor::DimBlue => 0x0100_0004,
                    NamedColor::DimMagenta => 0x0100_0005,
                    NamedColor::DimCyan => 0x0100_0006,
                    NamedColor::DimWhite => 0x0100_0007,
                    NamedColor::BrightForeground => 0x0100_000f,
                    _ => 0,
                }
            }
        }
    }
}

/// bold 1, italic 2, underline 4, inverse 8, dim 16, strike 32, hidden 64.
fn attrs(f: Flags) -> u16 {
    let mut a = 0;
    if f.contains(Flags::BOLD) {
        a |= 1;
    }
    if f.contains(Flags::ITALIC) {
        a |= 2;
    }
    if f.intersects(Flags::ALL_UNDERLINES) {
        a |= 4;
    }
    if f.contains(Flags::INVERSE) {
        a |= 8;
    }
    if f.contains(Flags::DIM) {
        a |= 16;
    }
    if f.contains(Flags::STRIKEOUT) {
        a |= 32;
    }
    if f.contains(Flags::HIDDEN) {
        a |= 64;
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::formats::PaneModes;
    use crate::tmux::seed::Seed;

    #[test]
    fn feeds_and_snapshots() {
        let mut t = TileTerm::new(10, 3);
        t.feed(b"hi \x1b[31mred\x1b[0m\r\nline2");
        assert_eq!(t.text(), "hi red\nline2\n\n");
        let snap = t.snapshot();
        assert_eq!(u16::from_le_bytes([snap[0], snap[1]]), 10);
        assert_eq!(u16::from_le_bytes([snap[2], snap[3]]), 3);
        // cursor after "line2"
        assert_eq!(u16::from_le_bytes([snap[4], snap[5]]), 5);
        assert_eq!(u16::from_le_bytes([snap[6], snap[7]]), 1);
        // row 0 has two runs: "hi " default and "red" in palette 1
        assert_eq!(u16::from_le_bytes([snap[9], snap[10]]), 2);
    }

    /// Feeding `serialize()` into a fresh terminal of the same size reproduces the screen,
    /// the scrollback, wrapped lines, styles and the cursor.
    #[test]
    fn serialize_round_trips() {
        let mut t = TileTerm::with_listener(12, 4, 100, VoidListener);
        for i in 0..8 {
            t.feed(format!("line {i}\r\n").as_bytes());
        }
        t.feed(b"\x1b[1;31mbold red\x1b[0m and a line that wraps around\r\n$ ");
        let bytes = t.serialize();
        let mut u = TileTerm::with_listener(12, 4, 100, VoidListener);
        u.feed(&bytes);
        assert_eq!(u.text(), t.text());
        assert_eq!(u.snapshot(), t.snapshot(), "styles and cursor survive");
        assert_eq!(u.term.grid().history_size(), t.term.grid().history_size(), "scrollback survives");
        // A second round trip is stable (wrapped rows stayed wrapped).
        assert_eq!(u.serialize(), bytes);
    }

    #[test]
    fn serialize_restores_modes_and_alt_screen() {
        let mut t = TileTerm::with_listener(10, 3, 50, VoidListener);
        t.feed(b"prompt$ \x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?25l\x1b[2;3Hvim");
        let mut u = TileTerm::with_listener(10, 3, 50, VoidListener);
        u.feed(&t.serialize());
        assert_eq!(u.text(), t.text());
        assert_eq!(u.mode(), t.mode());
    }

    #[test]
    fn collector_answers_queries() {
        let c = Collector::default();
        let mut t = TileTerm::with_listener(10, 3, 0, c.clone());
        t.feed(b"ab\x1b[6n\x1b[c");
        let replies: Vec<String> = c
            .drain()
            .into_iter()
            .filter_map(|e| if let Event::PtyWrite(s) = e { Some(s) } else { None })
            .collect();
        assert_eq!(replies[0], "\x1b[1;3R");
        assert!(replies[1].starts_with("\x1b[?"));
    }

    #[test]
    fn seed_reproduces_screen() {
        let seed = Seed {
            history: vec![b"old history".to_vec()],
            visible: vec![b"$ ls".to_vec(), b"a  b".to_vec(), b"$ ".to_vec()],
            modes: PaneModes { cursor_x: 2, cursor_y: 2, cursor_visible: true, wrap: true, width: 8, height: 3, scroll_lower: 2, history_size: 1, ..Default::default() },
        };
        let mut t = TileTerm::new(8, 3);
        t.feed(b"garbage that should be reset");
        t.feed(&seed.to_terminal_bytes());
        assert_eq!(t.text(), "$ ls\na  b\n$\n");
        t.feed(b"echo");
        assert_eq!(t.text(), "$ ls\na  b\n$ echo\n");
    }
}
