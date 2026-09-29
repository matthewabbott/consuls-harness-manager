//! Files for the explorer (and, later, the editor): the same operations over SFTP for remote
//! machines and `std::fs` for This PC. Paths are absolute and use forward slashes (also for
//! Windows paths, `C:/Users/…`).

pub mod git;
pub(crate) mod local;
pub(crate) mod remote;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A change to the file system, requested by the explorer.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
#[ts(export)]
pub enum FsOp {
    Mkdir { path: String },
    /// Fails if the file already exists.
    CreateFile { path: String },
    /// Fails if `to` already exists.
    Rename { from: String, to: String },
    /// Files, symlinks, or whole directory trees.
    Remove { path: String },
}

/// Most items counted before giving up (the delete confirmation then says "100,000+").
pub const COUNT_CAP: u64 = 100_000;

/// The last path component (for error messages).
pub(crate) fn base_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// Files up to this size open in the editor.
pub const EDIT_LIMIT: u64 = 5 * 1024 * 1024;
/// Files up to this size also get a content hash in their stamp (mtime has 1 s resolution,
/// so a same-size edit within the same second would otherwise go unnoticed).
pub const HASH_LIMIT: u64 = 2 * 1024 * 1024;
/// Largest file sent as raw bytes (image preview, pasted images).
pub const BYTES_LIMIT: u64 = 20 * 1024 * 1024;

/// Pasted images older than this are removed when the next one is saved.
pub(crate) const PASTE_DAYS: u64 = 7;

/// A fresh file name for an image pasted into the composer, or `None` for a type agents
/// can't read (they take PNG, JPEG, GIF and WebP).
pub(crate) fn paste_name(ext: &str) -> Option<String> {
    let ext = match ext.to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        _ => return None,
    };
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let id = uuid::Uuid::new_v4().simple().to_string();
    Some(format!("paste-{secs}-{}.{ext}", &id[..6]))
}

/// What a file looked like when read or written, to notice changes made by someone else.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileStamp {
    #[ts(type = "number")]
    pub size: u64,
    /// Unix seconds.
    #[ts(type = "number")]
    pub mtime: u64,
    /// FNV-1a of the bytes, for files up to [`HASH_LIMIT`].
    pub hash: Option<String>,
}

/// A file opened for editing.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
#[ts(export)]
pub enum FileContent {
    /// UTF-8 text (a leading BOM is removed and reported).
    Text { text: String, bom: bool, stamp: FileStamp },
    /// Not UTF-8 text (NUL bytes or invalid UTF-8).
    Binary { stamp: FileStamp },
    /// Bigger than [`EDIT_LIMIT`].
    TooLarge { stamp: FileStamp },
}

/// Why a save didn't happen.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
#[ts(export)]
pub enum SaveError {
    /// The file changed on disk since `expect` (current stamp attached, `None` if deleted).
    Conflict { current: Option<FileStamp> },
    Failed { message: String },
}

impl From<String> for SaveError {
    fn from(message: String) -> Self {
        SaveError::Failed { message }
    }
}

pub fn hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub(crate) fn stamp_of(bytes: Option<&[u8]>, size: u64, mtime: u64) -> FileStamp {
    FileStamp { size, mtime, hash: bytes.filter(|b| b.len() as u64 <= HASH_LIMIT).map(hash) }
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Decodes file bytes for the editor.
pub(crate) fn decode(bytes: Vec<u8>, stamp: FileStamp) -> FileContent {
    if bytes.contains(&0) {
        return FileContent::Binary { stamp };
    }
    let bom = bytes.starts_with(BOM);
    let body = if bom { bytes[BOM.len()..].to_vec() } else { bytes };
    match String::from_utf8(body) {
        Ok(text) => FileContent::Text { text, bom, stamp },
        Err(_) => FileContent::Binary { stamp },
    }
}

/// The bytes to write for editor text.
pub(crate) fn encode(text: &str, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    if bom {
        out.extend_from_slice(BOM);
    }
    out.extend_from_slice(text.as_bytes());
    out
}

/// Whether the file on disk (`current`) is still the one the editor loaded (`expect`).
pub(crate) fn unchanged(expect: &FileStamp, current: &FileStamp) -> bool {
    expect.size == current.size
        && expect.mtime == current.mtime
        && match (&expect.hash, &current.hash) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_handles_bom_binary_and_invalid_utf8() {
        let s = stamp_of(None, 0, 0);
        assert_eq!(decode(b"\xEF\xBB\xBFhi\r\n".to_vec(), s.clone()), FileContent::Text { text: "hi\r\n".into(), bom: true, stamp: s.clone() });
        assert!(matches!(decode(b"a\0b".to_vec(), s.clone()), FileContent::Binary { .. }));
        assert!(matches!(decode(vec![0xff, 0xfe, 0x41], s.clone()), FileContent::Binary { .. }));
        assert_eq!(encode("hi\r\n", true), b"\xEF\xBB\xBFhi\r\n");
    }

    #[test]
    fn stamps_compare_hash_when_both_have_one() {
        let a = stamp_of(Some(b"abc"), 3, 100);
        let b = stamp_of(Some(b"abd"), 3, 100);
        assert!(!unchanged(&a, &b), "same size and second, different bytes");
        assert!(unchanged(&a, &stamp_of(None, 3, 100)), "no hash on one side: size+mtime decide");
        assert!(!unchanged(&a, &stamp_of(None, 4, 100)));
    }
}
