use chm_core::model::{
    AlertKind, CoreSnapshot, DirListing, FocusState, HostConfig, NewPaneSpec, ResizeOutcome, SoundPrefs, TailnetStatus,
    TerminateOutcome,
};
use chm_core::integration::install::IntegrationStatus;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;

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
pub fn submit_prompt(state: State<'_, AppState>, key: u32, text: String) {
    state.core.submit_prompt(key, text);
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

#[tauri::command]
pub fn set_visible_panes(state: State<'_, AppState>, keys: Option<Vec<u32>>) {
    state.core.set_visible_panes(keys);
}
