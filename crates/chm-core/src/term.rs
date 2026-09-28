//! Per-pane terminal state (alacritty_terminal, visible screen only) and the compact
//! snapshot encoding the frontend paints mini tiles from.

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, StdSyncHandler};

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

pub struct TileTerm {
    term: Term<VoidListener>,
    parser: Processor<StdSyncHandler>,
    cols: u16,
    rows: u16,
}

impl TileTerm {
    pub fn new(cols: u16, rows: u16) -> Self {
        let size = Size { cols: cols.max(1) as usize, rows: rows.max(1) as usize };
        let config = Config { scrolling_history: 0, ..Config::default() };
        Self { term: Term::new(config, &size, VoidListener), parser: Processor::new(), cols, rows }
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
