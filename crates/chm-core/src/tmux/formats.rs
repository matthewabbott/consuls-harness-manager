//! tmux format strings we query, and parsers for their output.

use super::parser::{PaneId, SessionId, WindowId};

/// Field separator. tmux replaces control characters (even tabs) in `-F` output with `_`
/// when the client has no terminal, so we use a printable sequence that won't occur in ids.
pub const SEP: &str = "|~|";

/// `pane_title` is last because it's the only free-form field likely to contain `SEP`.
pub const PANE_FORMAT: &str = "#{pane_id}|~|#{window_id}|~|#{session_id}|~|#{session_name}|~|#{window_index}|~|#{window_name}|~|#{pane_index}|~|#{pane_width}|~|#{pane_height}|~|#{pane_current_command}|~|#{pane_current_path}|~|#{pane_pid}|~|#{pane_dead}|~|#{alternate_on}|~|#{window_active}|~|#{pane_active}|~|#{@chm_id}|~|#{@chm_harness}|~|#{@chm_hidden}|~|#{session_group}|~|#{window_panes}|~|#{window_width}|~|#{window_height}|~|#{@chm_sized}|~|#{@chm_labels}|~|#{@chm_bell}|~|#{@chm_name}|~|#{pane_title}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRow {
    pub pane: PaneId,
    pub window: WindowId,
    pub session: SessionId,
    pub session_name: String,
    pub window_index: u32,
    pub window_name: String,
    pub pane_index: u32,
    pub width: u16,
    pub height: u16,
    pub current_command: String,
    pub current_path: String,
    pub pid: u32,
    pub dead: bool,
    pub alternate_on: bool,
    pub window_active: bool,
    pub pane_active: bool,
    pub chm_id: Option<String>,
    pub chm_harness: Option<String>,
    pub chm_hidden: bool,
    pub session_group: Option<String>,
    pub window_panes: u32,
    pub window_width: u16,
    pub window_height: u16,
    /// Harness Manager pinned this window's size (see `@chm_sized`).
    pub sized: bool,
    /// Label ids from `@chm_labels` (comma-separated slugs).
    pub labels: Vec<String>,
    /// `@chm_bell`: the user's bell-ping choice for this pane.
    pub bell: Option<bool>,
    /// `@chm_name`: the name the user gave the pane.
    pub name: Option<String>,
    pub title: String,
}

/// Parses a `@chm_bell` value (`1`, `0`, or unset).
pub fn parse_bell(s: &str) -> Option<bool> {
    match s {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// Parses a comma-separated `@chm_labels` value.
pub fn parse_labels(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

fn id(prefix: char, s: &str) -> Option<u32> {
    s.strip_prefix(prefix)?.parse().ok()
}

fn opt(s: &str) -> Option<String> {
    Some(s.to_string()).filter(|s| !s.is_empty())
}

pub fn parse_pane_row(line: &str) -> Option<PaneRow> {
    let f: Vec<&str> = line.splitn(28, SEP).collect();
    if f.len() < 28 {
        return None;
    }
    Some(PaneRow {
        pane: id('%', f[0])?,
        window: id('@', f[1])?,
        session: id('$', f[2])?,
        session_name: f[3].to_string(),
        window_index: f[4].parse().unwrap_or(0),
        window_name: f[5].to_string(),
        pane_index: f[6].parse().unwrap_or(0),
        width: f[7].parse().ok()?,
        height: f[8].parse().ok()?,
        current_command: f[9].to_string(),
        current_path: f[10].to_string(),
        pid: f[11].parse().unwrap_or(0),
        dead: f[12] == "1",
        alternate_on: f[13] == "1",
        window_active: f[14] == "1",
        pane_active: f[15] == "1",
        chm_id: opt(f[16]),
        chm_harness: opt(f[17]),
        chm_hidden: f[18] == "1",
        session_group: opt(f[19]),
        window_panes: f[20].parse().unwrap_or(1),
        window_width: f[21].parse().unwrap_or(0),
        window_height: f[22].parse().unwrap_or(0),
        sized: f[23] == "1",
        labels: parse_labels(f[24]),
        bell: parse_bell(f[25]),
        name: opt(f[26]),
        title: f[27].to_string(),
    })
}

pub const SESSION_FORMAT: &str = "#{session_id}|~|#{session_name}|~|#{session_group}|~|#{session_attached}|~|#{start_time}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub session: SessionId,
    pub name: String,
    pub group: Option<String>,
    pub attached: u32,
    /// tmux server start time; changes when the server restarts (pane ids get reused).
    pub server_start: u64,
}

impl SessionRow {
    /// Sessions in the same group share windows, so we attach one control client per group.
    pub fn group_key(&self) -> String {
        match &self.group {
            Some(g) => format!("group:{g}"),
            None => format!("session:{}", self.session),
        }
    }
}

pub fn parse_session_row(line: &str) -> Option<SessionRow> {
    let f: Vec<&str> = line.split(SEP).collect();
    if f.len() < 5 {
        return None;
    }
    Some(SessionRow {
        session: id('$', f[0])?,
        name: f[1].to_string(),
        group: opt(f[2]),
        attached: f[3].parse().unwrap_or(0),
        server_start: f[4].trim().parse().unwrap_or(0),
    })
}

/// Cursor and terminal-mode state needed to reproduce a pane's screen exactly.
pub const MODES_FORMAT: &str = "#{cursor_x},#{cursor_y},#{cursor_flag},#{alternate_on},#{scroll_region_upper},#{scroll_region_lower},#{insert_flag},#{origin_flag},#{wrap_flag},#{keypad_cursor_flag},#{keypad_flag},#{pane_width},#{pane_height},#{history_size}";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PaneModes {
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub cursor_visible: bool,
    pub alternate_on: bool,
    pub scroll_upper: u16,
    pub scroll_lower: u16,
    pub insert: bool,
    pub origin: bool,
    pub wrap: bool,
    pub keypad_cursor: bool,
    pub keypad: bool,
    pub width: u16,
    pub height: u16,
    pub history_size: u32,
}

pub fn parse_modes(line: &str) -> Option<PaneModes> {
    let f: Vec<&str> = line.trim().split(',').collect();
    if f.len() < 13 {
        return None;
    }
    let n = |i: usize| f[i].parse::<u16>().ok();
    let b = |i: usize| f[i] == "1";
    Some(PaneModes {
        cursor_x: n(0)?,
        cursor_y: n(1)?,
        cursor_visible: b(2),
        alternate_on: b(3),
        scroll_upper: n(4).unwrap_or(0),
        scroll_lower: n(5).unwrap_or_else(|| n(12).unwrap_or(1).saturating_sub(1)),
        insert: b(6),
        origin: b(7),
        wrap: f[8] != "0",
        keypad_cursor: b(9),
        keypad: b(10),
        width: n(11)?,
        height: n(12)?,
        history_size: f.get(13).and_then(|v| v.parse().ok()).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_row() {
        let line = "%1|~|@1|~|$1|~|annotator-omp-1|~|1|~|bash|~|1|~|68|~|22|~|omp|~|/home/c/proj|~|401604|~|0|~|0|~|1|~|1|~||~||~||~|annotator-omp|~|2|~|137|~|22|~|1|~|terrarium,urgent|~|0|~|PR #12 review|~|_ > Hysteresis|~|benchmark";
        let row = parse_pane_row(line).unwrap();
        assert_eq!((row.pane, row.window, row.session), (1, 1, 1));
        assert_eq!((row.width, row.height), (68, 22));
        assert_eq!(row.current_command, "omp");
        assert_eq!(row.session_group.as_deref(), Some("annotator-omp"));
        assert_eq!(row.chm_id, None);
        assert_eq!(row.title, "_ > Hysteresis|~|benchmark");
        assert_eq!((row.window_panes, row.window_width, row.window_height, row.sized), (2, 137, 22, true));
        assert_eq!(row.labels, vec!["terrarium", "urgent"]);
        assert_eq!(row.bell, Some(false));
        assert_eq!(row.name.as_deref(), Some("PR #12 review"));
    }

    #[test]
    fn session_row_and_groups() {
        let a = parse_session_row("$1|~|annotator-omp-1|~|annotator-omp|~|1|~|1790000000").unwrap();
        let b = parse_session_row("$4|~|scratch|~||~|0|~|1790000000").unwrap();
        assert_eq!(a.group_key(), "group:annotator-omp");
        assert_eq!(b.group_key(), "session:4");
    }

    #[test]
    fn modes() {
        let m = parse_modes("5,23,1,0,0,23,0,0,1,1,0,80,24,1500\n").unwrap();
        assert_eq!((m.cursor_x, m.cursor_y, m.width, m.height), (5, 23, 80, 24));
        assert!(m.cursor_visible && m.wrap && m.keypad_cursor && !m.alternate_on);
        assert_eq!(m.history_size, 1500);
    }
}
