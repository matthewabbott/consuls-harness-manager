//! Uploads and downloads between this computer and another machine. Files picked in a dialog or
//! dropped on the explorer stream from disk to the machine (folders whole); a download asks
//! where to save, then streams there. Progress goes to the UI over a channel, one id per file.
//! What lands on the machine never replaces anything there (the core numbers taken names).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chm_core::Core;
use chm_core::fs::FsOp;
use chm_core::local::LOCAL_HOST;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::AppState;

type CmdResult<T> = Result<T, String>;

/// Progress, sent while a file moves.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TransferEvent {
    /// A file waiting its turn. `upload`: from here to the machine.
    Queued { id: u64, name: String, total: u64, upload: bool },
    Progress { id: u64, done: u64 },
    /// Where it landed: on the machine (upload) or here (download).
    Done { id: u64, path: String },
    Failed { id: u64, error: String },
}

/// Transfers under way, so the UI can cancel one.
#[derive(Default)]
pub struct Transfers {
    next: AtomicU64,
    flags: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl Transfers {
    fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        self.flags.lock().unwrap().insert(id, flag.clone());
        (id, flag)
    }

    fn end(&self, id: u64) {
        self.flags.lock().unwrap().remove(&id);
    }

    fn cancel(&self, id: u64) {
        if let Some(flag) = self.flags.lock().unwrap().get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

const CHUNK: usize = 256 * 1024;
/// Progress events at most this often per file.
const TICK: Duration = Duration::from_millis(120);

fn join(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}

fn file_name(p: &Path) -> String {
    p.file_name().map_or_else(|| p.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

/// One step of an upload: a folder to make on the machine, or a file to send into one.
enum Step {
    Mkdir(String),
    Send(Outgoing),
}

/// A file from here, and where it goes.
struct Outgoing {
    local: PathBuf,
    dir: String,
    name: String,
    total: u64,
}

/// Every file and folder under `local`, as steps into `remote` (which is new, so names are kept).
/// Links to folders aren't followed (they can loop); links to files send the file.
fn walk(local: &Path, remote: &str, steps: &mut Vec<Step>) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(local)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let link = e.file_type()?.is_symlink();
        let Ok(meta) = std::fs::metadata(&path) else { continue }; // a dangling link
        if meta.is_dir() {
            if link {
                continue;
            }
            let sub = join(remote, &name);
            steps.push(Step::Mkdir(sub.clone()));
            walk(&path, &sub, steps)?;
        } else {
            steps.push(Step::Send(Outgoing { local: path, dir: remote.to_string(), name, total: meta.len() }));
        }
    }
    Ok(())
}

/// What sending `paths` into `dir` takes: files as they are (the core numbers a taken name),
/// folders whole under a free name.
async fn plan(core: &Core, host: &str, dir: &str, paths: Vec<PathBuf>) -> Result<Vec<Step>, String> {
    let mut steps = Vec::new();
    let mut taken: Option<HashSet<String>> = None;
    for p in paths {
        let meta = tokio::fs::metadata(&p).await.map_err(|e| format!("{}: {e}", p.display()))?;
        let name = file_name(&p);
        if meta.is_dir() {
            if taken.is_none() {
                let listing = core.list_dir(host, dir).await?;
                taken = Some(listing.entries.into_iter().map(|e| e.name).collect());
            }
            let taken = taken.as_mut().unwrap();
            let folder = (0..).map(|n| chm_core::fs::numbered(&name, n)).find(|n| !taken.contains(n)).unwrap();
            taken.insert(folder.clone());
            let remote = join(dir, &folder);
            steps.push(Step::Mkdir(remote.clone()));
            let local = p.clone();
            let inner = tokio::task::spawn_blocking(move || {
                let mut inner = Vec::new();
                walk(&local, &remote, &mut inner).map(|_| inner)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("{}: {e}", p.display()))?;
            steps.extend(inner);
        } else {
            steps.push(Step::Send(Outgoing { local: p, dir: dir.to_string(), name, total: meta.len() }));
        }
    }
    Ok(steps)
}

/// Streams one file to the machine; the path it got.
async fn send(core: &Arc<Core>, host: &str, out: &Outgoing, id: u64, stop: &AtomicBool, events: &Channel<TransferEvent>) -> Result<String, String> {
    let Outgoing { local, dir, name, total } = out;
    let total = *total;
    let mut file = tokio::fs::File::open(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let landing = {
        let (core, host, dir, name) = (core.clone(), host.to_string(), dir.to_string(), name.to_string());
        tokio::spawn(async move { core.upload(&host, &dir, &name, total, rx).await })
    };
    let mut buf = vec![0u8; CHUNK];
    let (mut done, mut told) = (0u64, Instant::now());
    loop {
        if stop.load(Ordering::Relaxed) {
            break; // the core sees a short upload and leaves nothing
        }
        let n = match file.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                let _ = tx.send(Err(format!("{}: {e}", local.display()))).await;
                break;
            }
        };
        if n == 0 || tx.send(Ok(Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
            break;
        }
        done += n as u64;
        if told.elapsed() >= TICK {
            let _ = events.send(TransferEvent::Progress { id, done });
            told = Instant::now();
        }
    }
    drop(tx);
    let landed = landing.await.map_err(|e| e.to_string())?;
    if stop.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    landed
}

async fn run(core: Arc<Core>, host: String, steps: Vec<Step>, transfers: Arc<Transfers>, events: Channel<TransferEvent>) {
    // Every file is listed first, so the UI shows the whole queue.
    let queue: Vec<_> = steps
        .into_iter()
        .map(|step| {
            let ticket = match &step {
                Step::Send(out) => {
                    let (id, stop) = transfers.begin();
                    let _ = events.send(TransferEvent::Queued { id, name: out.name.clone(), total: out.total, upload: true });
                    Some((id, stop))
                }
                Step::Mkdir(_) => None,
            };
            (step, ticket)
        })
        .collect();
    for (step, ticket) in queue {
        match (step, ticket) {
            (Step::Mkdir(path), _) => {
                // A folder that couldn't be made fails the files sent into it, each with its error.
                let _ = core.fs_op(&host, FsOp::Mkdir { path }).await;
            }
            (Step::Send(out), Some((id, stop))) => {
                let event = if stop.load(Ordering::Relaxed) {
                    TransferEvent::Failed { id, error: "cancelled".into() }
                } else {
                    match send(&core, &host, &out, id, &stop, &events).await {
                        Ok(path) => TransferEvent::Done { id, path },
                        Err(error) => TransferEvent::Failed { id, error },
                    }
                };
                let _ = events.send(event);
                transfers.end(id);
            }
            (Step::Send(_), None) => {}
        }
    }
}

#[cfg(desktop)]
async fn pick_upload(app: &AppHandle, folder: bool) -> Result<Vec<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file().set_title(if folder { "Upload folders" } else { "Upload files" });
    if folder {
        dialog.pick_folders(move |p| drop(tx.send(p)));
    } else {
        dialog.pick_files(move |p| drop(tx.send(p)));
    }
    let picked = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    picked.into_iter().map(|p| p.into_path().map_err(|e| e.to_string())).collect()
}

#[cfg(not(desktop))]
async fn pick_upload(_app: &AppHandle, _folder: bool) -> Result<Vec<PathBuf>, String> {
    Err("not on this device".into())
}

/// Sends files or folders from this computer into `dir` on a machine: `paths` (dropped on the
/// explorer), or picked in a dialog when there are none (`folder`: pick folders). Returns once
/// it's under way; the channel tells how it goes.
#[tauri::command]
pub async fn upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    dir: String,
    paths: Option<Vec<String>>,
    folder: bool,
    on_event: Channel<TransferEvent>,
) -> CmdResult<()> {
    if host == LOCAL_HOST {
        return Err("those files are on this computer already".into());
    }
    let paths = match paths {
        Some(p) => p.into_iter().map(PathBuf::from).collect(),
        None => pick_upload(&app, folder).await?,
    };
    if paths.is_empty() {
        return Ok(());
    }
    let core = state.core.clone();
    let steps = plan(&core, &host, &dir, paths).await?;
    tauri::async_runtime::spawn(run(core, host, steps, state.transfers.clone(), on_event));
    Ok(())
}

#[cfg(desktop)]
async fn pick_save(app: &AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_file_name(name);
    if let Ok(dir) = app.path().download_dir() {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |p| drop(tx.send(p)));
    rx.await.map_err(|e| e.to_string())?.map(|p| p.into_path().map_err(|e| e.to_string())).transpose()
}

#[cfg(not(desktop))]
async fn pick_save(_app: &AppHandle, _name: &str) -> Result<Option<PathBuf>, String> {
    Err("not on this device".into())
}

/// Asks where to save `path` from a machine, then downloads it there (to a temporary name
/// beside it first; the save dialog already asked before replacing a file).
#[tauri::command]
pub async fn download_to(app: AppHandle, state: State<'_, AppState>, host: String, path: String, on_event: Channel<TransferEvent>) -> CmdResult<()> {
    if host == LOCAL_HOST {
        return Err("that file is on this computer already".into());
    }
    let name = path.rsplit('/').next().unwrap_or("download").to_string();
    let Some(dest) = pick_save(&app, &name).await? else { return Ok(()) };
    let (size, mut rx) = state.core.download(&host, &path).await?;
    let transfers = state.transfers.clone();
    let (id, stop) = transfers.begin();
    let _ = on_event.send(TransferEvent::Queued { id, name, total: size, upload: false });
    tauri::async_runtime::spawn(async move {
        let part = dest.with_file_name(format!(".{}.consuls-part", file_name(&dest)));
        let result: Result<(), String> = async {
            let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("{}: {e}", part.display()))?;
            let (mut done, mut told) = (0u64, Instant::now());
            while let Some(chunk) = rx.recv().await {
                if stop.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                let chunk = chunk?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                done += chunk.len() as u64;
                if told.elapsed() >= TICK {
                    let _ = on_event.send(TransferEvent::Progress { id, done });
                    told = Instant::now();
                }
            }
            if done != size {
                return Err(format!("stopped after {done} of {size} bytes"));
            }
            file.sync_all().await.map_err(|e| e.to_string())?;
            drop(file);
            tokio::fs::rename(&part, &dest).await.map_err(|e| format!("{}: {e}", dest.display()))
        }
        .await;
        let event = match result {
            Ok(()) => TransferEvent::Done { id, path: chm_core::local::to_slash(&dest) },
            Err(error) => {
                let _ = tokio::fs::remove_file(&part).await;
                TransferEvent::Failed { id, error }
            }
        };
        let _ = on_event.send(event);
        transfers.end(id);
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, id: u64) {
    state.transfers.cancel(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_is_sent_whole_without_following_links_to_folders() {
        let base = std::env::temp_dir().join(format!("chm-walk-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("photos/2026")).unwrap();
        std::fs::write(base.join("photos/a.jpg"), "aa").unwrap();
        std::fs::write(base.join("photos/2026/b.jpg"), "bbb").unwrap();
        #[cfg(unix)]
        {
            // A loop and a link to a file.
            std::os::unix::fs::symlink(base.join("photos"), base.join("photos/2026/loop")).unwrap();
            std::os::unix::fs::symlink(base.join("photos/a.jpg"), base.join("photos/link.jpg")).unwrap();
        }
        let mut steps = Vec::new();
        walk(&base.join("photos"), "/srv/up/photos", &mut steps).unwrap();
        let got: Vec<String> = steps
            .iter()
            .map(|s| match s {
                Step::Mkdir(p) => format!("mkdir {p}"),
                Step::Send(o) => format!("send {}/{} {}", o.dir, o.name, o.total),
            })
            .collect();
        let mut want = vec!["mkdir /srv/up/photos/2026", "send /srv/up/photos/2026/b.jpg 3", "send /srv/up/photos/a.jpg 2"];
        #[cfg(unix)]
        want.push("send /srv/up/photos/link.jpg 2");
        assert_eq!(got, want);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
