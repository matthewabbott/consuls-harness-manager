//! `git status` for the explorer's badges: porcelain v2 (stable, NUL-separated) with ignored
//! files, parsed into one status per path relative to the repository root.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GitFileStatus {
    // Ordered by how loudly a folder should show it when rolled up.
    Ignored,
    Renamed,
    Added,
    Untracked,
    Modified,
    Deleted,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitEntry {
    /// Relative to the repository root, `/`-separated; ignored directories end with `/`.
    pub path: String,
    pub status: GitFileStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitStatus {
    /// Absolute repository root (forward slashes).
    pub root: String,
    pub branch: Option<String>,
    pub entries: Vec<GitEntry>,
}

/// A file's committed version, for the editor's change gutter.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
#[ts(export)]
pub enum HeadVersion {
    /// Not in a git work tree (no gutter).
    NotInRepo,
    /// In a repository but not in HEAD (everything counts as added).
    Untracked,
    /// The file's text at HEAD (BOM stripped).
    Text { text: String },
    /// Binary or larger than [`HEAD_LIMIT`] (no gutter).
    Skipped,
}

/// Largest committed version the gutter compares against.
pub const HEAD_LIMIT: usize = 1024 * 1024;

/// Interprets `git show HEAD:<file>` output.
pub fn head_from_bytes(bytes: Vec<u8>) -> HeadVersion {
    if bytes.len() > HEAD_LIMIT || bytes.contains(&0) {
        return HeadVersion::Skipped;
    }
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF".as_slice()).map(<[u8]>::to_vec).unwrap_or(bytes);
    match String::from_utf8(body) {
        Ok(text) => HeadVersion::Text { text },
        Err(_) => HeadVersion::Skipped,
    }
}

/// A POSIX script printing the HEAD version of `path`. Exit 4: not in a work tree; 5: not in HEAD.
pub fn head_script(path: &str) -> String {
    let (dir, name) = match path.rfind('/') {
        Some(0) => ("/", &path[1..]),
        Some(i) => (&path[..i], &path[i + 1..]),
        None => (".", path),
    };
    let q = crate::ssh::exec::sh_quote;
    format!(
        "cd {} 2>/dev/null || exit 4\ngit rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4\ngit cat-file -e HEAD:./{} 2>/dev/null || exit 5\nexec git show HEAD:./{}",
        q(dir),
        q(name),
        q(name)
    )
}

/// The status command, run from the repository root.
pub const STATUS_ARGS: [&str; 6] = ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--ignored=matching", "--branch"];

/// A POSIX script that prints `<root>\0<status output>` for the repository containing `dir`
/// (exit 4 when `dir` isn't in one). The root is given the way `dir` names it: git reports the
/// real path, which differs under a symlink (macOS `/tmp` is `/private/tmp`), and the explorer
/// matches statuses against the paths it shows.
pub fn remote_script(dir: &str) -> String {
    format!(
        r#"cd {} 2>/dev/null || exit 3
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 4
pre=$(git rev-parse --show-prefix 2>/dev/null); here=$(pwd -L); root=$top
case "$pre" in
  "") root=$here ;;
  *) p=${{pre%/}}; case "$here" in */"$p") root=${{here%/"$p"}} ;; esac ;;
esac
printf '%s\0' "$root"
cd "$top" && exec git {}"#,
        crate::ssh::exec::sh_quote(dir),
        STATUS_ARGS.join(" ")
    )
}

fn classify(xy: &str) -> GitFileStatus {
    let (x, y) = (xy.chars().next().unwrap_or('.'), xy.chars().nth(1).unwrap_or('.'));
    if x == 'D' || y == 'D' {
        GitFileStatus::Deleted
    } else if x == 'A' {
        GitFileStatus::Added
    } else if x == 'R' || x == 'C' {
        GitFileStatus::Renamed
    } else {
        GitFileStatus::Modified
    }
}

/// Parses `git status --porcelain=v2 -z --branch` output.
pub fn parse(out: &[u8]) -> (Option<String>, Vec<GitEntry>) {
    let text = String::from_utf8_lossy(out);
    let mut fields = text.split('\0');
    let mut branch = None;
    let mut entries = Vec::new();
    while let Some(f) = fields.next() {
        if let Some(rest) = f.strip_prefix("# branch.head ") {
            branch = Some(rest.to_string()).filter(|b| b != "(detached)");
            continue;
        }
        let mut parts = f.splitn(2, ' ');
        let kind = parts.next().unwrap_or_default();
        let rest = parts.next().unwrap_or_default();
        let (path, status) = match kind {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            "1" => match rest.splitn(8, ' ').collect::<Vec<_>>()[..] {
                [xy, _, _, _, _, _, _, path] => (path, classify(xy)),
                _ => continue,
            },
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>, then the original path as its own field
            "2" => {
                let _orig = fields.next();
                match rest.splitn(9, ' ').collect::<Vec<_>>()[..] {
                    [xy, _, _, _, _, _, _, _, path] => (path, classify(xy)),
                    _ => continue,
                }
            }
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            "u" => match rest.splitn(10, ' ').collect::<Vec<_>>()[..] {
                [_, _, _, _, _, _, _, _, _, path] => (path, GitFileStatus::Conflicted),
                _ => continue,
            },
            "?" => (rest, GitFileStatus::Untracked),
            "!" => (rest, GitFileStatus::Ignored),
            _ => continue,
        };
        if !path.is_empty() {
            entries.push(GitEntry { path: path.to_string(), status });
        }
    }
    (branch, entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = b"# branch.oid 0123\0# branch.head v2\0\
1 .M N... 100644 100644 100644 aaa bbb src/App.tsx\0\
1 A. N... 000000 100644 100644 000 ccc src/new file.ts\0\
1 D. N... 100644 000000 000000 ddd 000 old.txt\0\
2 R. N... 100644 100644 100644 eee eee R100 docs/renamed.md\0docs/orig.md\0\
u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.rs\0\
? scratch.txt\0\
! target/\0";
        let (branch, entries) = parse(out);
        assert_eq!(branch.as_deref(), Some("v2"));
        let got: Vec<(&str, GitFileStatus)> = entries.iter().map(|e| (e.path.as_str(), e.status)).collect();
        assert_eq!(
            got,
            vec![
                ("src/App.tsx", GitFileStatus::Modified),
                ("src/new file.ts", GitFileStatus::Added),
                ("old.txt", GitFileStatus::Deleted),
                ("docs/renamed.md", GitFileStatus::Renamed),
                ("conflict.rs", GitFileStatus::Conflicted),
                ("scratch.txt", GitFileStatus::Untracked),
                ("target/", GitFileStatus::Ignored),
            ]
        );
    }

    #[test]
    fn detached_head_has_no_branch() {
        assert_eq!(parse(b"# branch.head (detached)\0").0, None);
    }
}
