use chm_core::model::{
    AlertKind, CoreSnapshot, DirListing, FocusState, HostConfig, LabelDef, NewPaneSpec, ResizeOutcome, SoundPrefs,
    TailnetStatus, TerminateOutcome, UiPrefs,
};
use chm_core::integration::install::IntegrationStatus;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;
use crate::vscode::{self, Target, VsCode, VsCodeStatus};

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn get_snapshot(state: State<'_, AppState>) -> CoreSnapshot {
    state.core.snapshot()
}

/// The UI hands us a channel for binary pane frames; every tile is re-sent.
#[tauri::command]
pub fn subscribe_frames(state: State<'_, AppState>, channel: Channel<InvokeResponseBody>) {
    *state.sink.channel.lock().unwrap() = Some(channel);
    state.core.resend_tiles();
}

#[tauri::command]
pub fn upsert_host(state: State<'_, AppState>, config: HostConfig) -> CmdResult<()> {
    if config.id.trim().is_empty() || config.user.trim().is_empty() {
        return Err("host id and user are required".into());
    }
    state.core.upsert_host(config);
    Ok(())
}

#[tauri::command]
pub fn remove_host(state: State<'_, AppState>, id: String) {
    state.core.remove_host(&id);
}

#[tauri::command]
pub fn connect_host(state: State<'_, AppState>, id: String) {
    state.core.connect(&id);
}

#[tauri::command]
pub fn disconnect_host(state: State<'_, AppState>, id: String) {
    state.core.disconnect(&id);
}

#[tauri::command]
pub fn reconnect_host(state: State<'_, AppState>, id: String) {
    state.core.reconnect(&id);
}

#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, id: String) {
    state.core.forget_host_key(&id);
}

#[tauri::command]
pub async fn refresh_tailnet(state: State<'_, AppState>) -> CmdResult<TailnetStatus> {
    Ok(state.core.refresh_tailnet().await)
}

/// Opens a URL in the user's browser. Only https URLs are allowed: terminal output is
/// untrusted, so the UI must never be able to launch arbitrary schemes or files.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    let ok = url.starts_with("https://") && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    if !ok {
        return Err(format!("refusing to open non-https URL: {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// A path on this PC from the UI (`C:/…` on Windows, `/…` elsewhere), as a native path that
/// exists. The UI may have taken it from terminal output, so nothing else gets through.
fn local_path(path: &str) -> CmdResult<std::path::PathBuf> {
    let bytes = path.as_bytes();
    let absolute = if cfg!(windows) {
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    } else {
        path.starts_with('/')
    };
    if !absolute || path.chars().any(char::is_control) {
        return Err(format!("not an absolute path: {path}"));
    }
    let native = std::path::PathBuf::from(if cfg!(windows) { path.replace('/', "\\") } else { path.to_string() });
    if !native.exists() {
        return Err(format!("{path} doesn't exist"));
    }
    Ok(native)
}

/// Shows a file or folder on this PC in File Explorer / Finder, selected.
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, host: String, path: String) -> CmdResult<()> {
    if host != chm_core::local::LOCAL_HOST {
        return Err("only files on this PC can be shown in the file manager".into());
    }
    app.opener().reveal_item_in_dir(local_path(&path)?).map_err(|e| e.to_string())
}

/// Default folders and recording mode, kept in config.json (the alerter follows the Config
/// event for recording mode).
#[tauri::command]
pub fn set_ui_prefs(state: State<'_, AppState>, prefs: UiPrefs) {
    state.core.set_ui_prefs(prefs);
}

/// Whether VS Code (and its Remote-SSH extension) is installed; checked on each call, so
/// installing either shows up without a restart.
#[tauri::command]
pub fn vscode_status() -> VsCodeStatus {
    VsCode::status(&VsCode::detect())
}

/// Opens a file (at a line) or folder in VS Code: local paths directly, paths on another
/// machine through Remote-SSH.
#[tauri::command]
pub fn open_in_vscode(state: State<'_, AppState>, host: String, path: String, line: Option<u32>, col: Option<u32>) -> CmdResult<()> {
    let code = VsCode::detect().ok_or("VS Code isn't installed")?;
    let target = if host == chm_core::local::LOCAL_HOST {
        Target::Local { path: local_path(&path)?, line, col }
    } else {
        if !code.remote_ssh {
            return Err("VS Code's Remote-SSH extension isn't installed".into());
        }
        if !path.starts_with('/') || path.chars().any(char::is_control) {
            return Err(format!("not an absolute path: {path}"));
        }
        let snap = state.core.snapshot();
        let cfg = snap.config.hosts.iter().find(|h| h.id == host).ok_or_else(|| format!("unknown machine {host}"))?;
        let peer = snap.tailnet.peers.iter().find(|p| p.id == host);
        let ssh_config = std::fs::read_to_string(std::path::Path::new(&chm_core::local::home()).join(".ssh/config")).unwrap_or_default();
        Target::Remote { authority: vscode::authority(cfg, peer, &ssh_config), path, line, col }
    };
    code.open(&target).map_err(|e| format!("couldn't start VS Code: {e}"))
}

#[tauri::command]
pub fn stream_pane(state: State<'_, AppState>, key: u32, on: bool) {
    state.core.stream_pane(key, on);
}

#[tauri::command]
pub fn send_keys(state: State<'_, AppState>, key: u32, keys: Vec<String>) {
    state.core.send_keys(key, keys);
}

#[tauri::command]
pub fn send_text(state: State<'_, AppState>, key: u32, text: String) {
    state.core.send_text(key, text);
}

#[tauri::command]
pub fn paste_text(state: State<'_, AppState>, key: u32, text: String) {
    state.core.paste_text(key, text);
}

#[tauri::command]
pub async fn fs_op(state: State<'_, AppState>, host: String, op: chm_core::fs::FsOp) -> CmdResult<()> {
    state.core.fs_op(&host, op).await
}

#[tauri::command]
pub async fn fs_count(state: State<'_, AppState>, host: String, path: String) -> CmdResult<u64> {
    state.core.fs_count(&host, &path).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, host: String, path: String) -> CmdResult<chm_core::fs::FileContent> {
    state.core.read_file(&host, &path).await
}

/// Raw bytes (image preview) as a binary IPC response, not a JSON number array.
#[tauri::command]
pub async fn read_bytes(state: State<'_, AppState>, host: String, path: String) -> Result<tauri::ipc::Response, String> {
    state.core.read_bytes(&host, &path).await.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn git_head(state: State<'_, AppState>, host: String, path: String) -> CmdResult<chm_core::fs::git::HeadVersion> {
    state.core.git_head(&host, &path).await
}

#[tauri::command]
pub async fn stat_file(state: State<'_, AppState>, host: String, path: String) -> CmdResult<Option<chm_core::fs::FileStamp>> {
    state.core.stat_file(&host, &path).await
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    host: String,
    path: String,
    text: String,
    bom: bool,
    expect: Option<chm_core::fs::FileStamp>,
) -> Result<chm_core::fs::FileStamp, chm_core::fs::SaveError> {
    state.core.write_file(&host, &path, text, bom, expect).await
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, host: String, dir: String) -> CmdResult<Option<chm_core::fs::git::GitStatus>> {
    state.core.git_status(&host, &dir).await
}

/// Ping (or not) on the pane's terminal bell; `null` = default for what's running.
#[tauri::command]
pub fn set_pane_bell(state: State<'_, AppState>, key: u32, bell: Option<bool>) {
    state.core.set_pane_bell(key, bell);
}

/// Shells that can be started on this machine ("This PC").
#[tauri::command]
pub fn local_shells(state: State<'_, AppState>) -> Vec<chm_core::local::LocalShell> {
    state.core.local_shells()
}

/// Drives on this machine, for the explorer's drive buttons.
#[tauri::command]
pub fn local_drives(state: State<'_, AppState>) -> Vec<chm_core::local::DriveInfo> {
    state.core.local_drives()
}

/// Quit for real (after the UI confirmed ending local shells).
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Raw terminal input (direct panes): xterm's own encoding of keys, mouse and replies.
#[tauri::command]
pub fn send_input(state: State<'_, AppState>, key: u32, data: String) {
    state.core.send_input(key, data.into_bytes());
}

#[tauri::command]
pub async fn integration_status(state: State<'_, AppState>, host: String) -> CmdResult<IntegrationStatus> {
    state.core.integration_status(&host).await
}

#[tauri::command]
pub async fn install_integration(state: State<'_, AppState>, host: String) -> CmdResult<IntegrationStatus> {
    state.core.install_integration(&host).await
}

#[tauri::command]
pub async fn uninstall_integration(state: State<'_, AppState>, host: String) -> CmdResult<IntegrationStatus> {
    state.core.uninstall_integration(&host).await
}

#[tauri::command]
pub fn set_sound_prefs(state: State<'_, AppState>, prefs: SoundPrefs) {
    state.core.set_sound_prefs(prefs);
}

#[tauri::command]
pub fn test_chime(state: State<'_, AppState>, kind: AlertKind, volume: f32) {
    state.sink.alerter.test(kind, volume);
}

#[tauri::command]
pub fn set_focus(state: State<'_, AppState>, focus: FocusState) {
    state.core.set_focus(focus);
}

#[tauri::command]
pub fn ack_pane(state: State<'_, AppState>, key: u32) {
    state.core.ack_pane(key);
}

#[tauri::command]
pub fn set_pane_muted(state: State<'_, AppState>, key: u32, muted: bool) {
    state.core.set_pane_muted(key, muted);
}

#[tauri::command]
pub fn submit_prompt(state: State<'_, AppState>, key: u32, text: String, images: Option<Vec<String>>) {
    state.core.submit_prompt(key, text, images.unwrap_or_default());
}

/// An image pasted into the composer: the raw bytes are the request body (not a JSON array);
/// the machine and image type come as headers. Returns the saved file's path.
#[tauri::command]
pub async fn save_paste(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the image's bytes".into()) };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let host = header("chm-host").ok_or("which machine?")?;
    let ext = header("chm-ext").ok_or("what kind of image?")?;
    state.core.save_paste(&host, bytes.clone(), &ext).await
}

#[tauri::command]
pub async fn create_pane(state: State<'_, AppState>, spec: NewPaneSpec) -> CmdResult<u32> {
    state.core.create_pane(spec).await
}

#[tauri::command]
pub async fn resize_pane(state: State<'_, AppState>, key: u32, cols: u16, rows: u16) -> CmdResult<ResizeOutcome> {
    state.core.resize_pane(key, cols, rows).await
}

#[tauri::command]
pub fn release_pane_size(state: State<'_, AppState>, key: u32) {
    state.core.release_pane_size(key);
}

#[tauri::command]
pub fn create_label(state: State<'_, AppState>, name: String, color: String) -> CmdResult<LabelDef> {
    if name.trim().is_empty() {
        return Err("label name is required".into());
    }
    Ok(state.core.create_label(&name, &color))
}

#[tauri::command]
pub fn update_label(state: State<'_, AppState>, label: LabelDef) {
    state.core.update_label(label);
}

#[tauri::command]
pub fn delete_label(state: State<'_, AppState>, id: String) {
    state.core.delete_label(&id);
}

#[tauri::command]
pub fn set_pane_labels(state: State<'_, AppState>, key: u32, labels: Vec<String>) {
    state.core.set_pane_labels(key, labels);
}

#[tauri::command]
pub fn rename_pane(state: State<'_, AppState>, key: u32, name: Option<String>) {
    state.core.rename_pane(key, name);
}

#[tauri::command]
pub fn set_pane_hidden(state: State<'_, AppState>, key: u32, hidden: bool) {
    state.core.set_pane_hidden(key, hidden);
}

#[tauri::command]
pub async fn terminate_pane(state: State<'_, AppState>, key: u32, force: bool) -> CmdResult<TerminateOutcome> {
    state.core.terminate_pane(key, force).await
}

#[tauri::command]
pub async fn list_dir(state: State<'_, AppState>, host: String, path: String) -> CmdResult<DirListing> {
    state.core.list_dir(&host, &path).await
}

/// The UI's per-device state (layout, zoom, composer drafts and history).
#[tauri::command]
pub fn get_ui_state(state: State<'_, AppState>) -> std::collections::BTreeMap<String, String> {
    state.core.ui_state()
}

#[tauri::command]
pub fn set_ui_state(state: State<'_, AppState>, key: String, value: Option<String>) {
    state.core.set_ui_state(key, value);
}

#[tauri::command]
pub fn set_visible_panes(state: State<'_, AppState>, keys: Option<Vec<u32>>) {
    state.core.set_visible_panes(keys);
}

#[cfg(test)]
mod tests {
    use super::local_path;

    #[test]
    fn local_paths_must_be_absolute_and_exist() {
        let here = chm_core::local::home();
        assert!(local_path(&here).unwrap().exists());
        assert!(local_path("relative/path").is_err());
        assert!(local_path(&format!("{here}/no-such-file-chm-test")).unwrap_err().contains("doesn't exist"));
        assert!(local_path(&format!("{here}\u{7}")).is_err());
        if cfg!(windows) {
            assert!(local_path("/Windows").is_err(), "drive-relative paths are refused");
            assert_eq!(local_path("C:/Windows").unwrap(), std::path::PathBuf::from(r"C:\Windows"));
        }
    }
}
