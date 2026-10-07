//! Dragging files out of the explorer, to Finder / File Explorer or another app. The system's
//! drag carries files that exist on this computer, so a file from another machine is first
//! downloaded to a temporary folder (`prepare_drag`, started as the drag begins); once the
//! pointer leaves the window, `start_drag_out` hands the drag to the system, which copies the
//! file wherever it's dropped.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use chm_core::local::LOCAL_HOST;
use tauri::State;
use tokio::io::AsyncWriteExt;

use crate::AppState;

type CmdResult<T> = Result<T, String>;

/// Files bigger than this aren't fetched just in case: Download… is the way for those.
pub const DRAG_LIMIT: u64 = 256 * 1024 * 1024;

fn drag_dir() -> PathBuf {
    std::env::temp_dir().join("consuls-drag")
}

/// Removes earlier drags' copies: a drop's copy has long finished after an hour.
fn prune() {
    let Ok(entries) = std::fs::read_dir(drag_dir()) else { return };
    let old = SystemTime::now() - Duration::from_secs(3600);
    for e in entries.flatten() {
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < old) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// A local copy of a file from `host` to drag out (its native path). Files on this computer
/// are dragged from where they are.
#[tauri::command]
pub async fn prepare_drag(state: State<'_, AppState>, host: String, path: String) -> CmdResult<String> {
    if host == LOCAL_HOST {
        return crate::commands::local_path(&path).map(|p| p.to_string_lossy().into_owned());
    }
    let (size, mut rx) = state.core.download(&host, &path).await?;
    if size > DRAG_LIMIT {
        return Err("too large to drag out: use Download…".into());
    }
    tokio::task::spawn_blocking(prune).await.map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = drag_dir().join(&id[..8]);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let dest = dir.join(path.rsplit('/').next().unwrap_or("download"));
    let mut file = tokio::fs::File::create(&dest).await.map_err(|e| e.to_string())?;
    let mut got = 0u64;
    while let Some(chunk) = rx.recv().await {
        let chunk = chunk?;
        got += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    if got != size {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(format!("stopped after {got} of {size} bytes"));
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Hands the drag to the system with these local files (the pointer is down, outside the
/// window by now). Returns at once; the system copies them where they're dropped.
#[tauri::command]
pub fn start_drag_out(app: tauri::AppHandle, window: tauri::Window, paths: Vec<String>) -> CmdResult<()> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if files.is_empty() || files.iter().any(|p| !p.is_absolute() || !p.exists()) {
        return Err("nothing to drag".into());
    }
    start(&app, window, files)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start(app: &tauri::AppHandle, window: tauri::Window, files: Vec<PathBuf>) -> CmdResult<()> {
    app.run_on_main_thread(move || {
        let icon = drag::Image::Raw(include_bytes!("../icons/64x64.png").to_vec());
        if let Err(e) = drag::start_drag(&window, drag::DragItem::Files(files), icon, |_, _| {}, drag::Options::default()) {
            tracing::warn!("couldn't start dragging out: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start(_app: &tauri::AppHandle, _window: tauri::Window, _files: Vec<PathBuf>) -> CmdResult<()> {
    Err("dragging files out isn't supported here".into())
}
