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
