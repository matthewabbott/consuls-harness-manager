//! Tauri shell: bridges chm-core to the webview. JSON events go through `emit`; pane
//! frames are batched and streamed as raw bytes over a single IPC channel.

mod alerts;
mod commands;
mod tray;
mod vscode;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chm_core::model::{Alert, CoreEvent};
use chm_core::{Core, Sink};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager};

pub struct AppSink {
    app: tauri::AppHandle,
    frames: Mutex<Vec<u8>>,
    channel: Mutex<Option<Channel<InvokeResponseBody>>>,
    alerter: alerts::Alerter,
}

impl Sink for AppSink {
    fn event(&self, event: CoreEvent) {
        if let CoreEvent::Config { config } = &event {
            self.alerter.set_prefs(config.sound.clone());
            self.alerter.set_recording(config.ui.recording);
        }
        let _ = self.app.emit("core-event", event);
    }

    fn frame(&self, frame: Vec<u8>) {
        let mut frames = self.frames.lock().unwrap();
        // Don't let frames pile up if the UI isn't listening (e.g. during a reload).
        if frames.len() > 32 * 1024 * 1024 {
            frames.clear();
        }
        frames.extend_from_slice(&frame);
    }

    fn alert(&self, alert: Alert) {
        self.alerter.alert(&self.app, alert);
    }
}

impl AppSink {
    fn flush(&self) {
        let batch = {
            let mut frames = self.frames.lock().unwrap();
            if frames.is_empty() {
                return;
            }
            std::mem::take(&mut *frames)
        };
        if let Some(channel) = self.channel.lock().unwrap().as_ref() {
            let _ = channel.send(InvokeResponseBody::Raw(batch));
        }
    }
}

pub struct AppState {
    pub core: Arc<Core>,
    pub sink: Arc<AppSink>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,russh=warn".into()))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            // Closing the window keeps Consuls running in the tray, so agents can still
            // ping you. Quit from the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            tray::install(app.handle())?;
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            let sink = Arc::new(AppSink {
                app: app.handle().clone(),
                frames: Mutex::new(Vec::new()),
                channel: Mutex::new(None),
                alerter: alerts::Alerter::new(),
            });
            let core = Core::new(data_dir, sink.clone());
            sink.alerter.set_prefs(core.sound_prefs());
            sink.alerter.set_recording(core.ui_prefs().recording);
            app.manage(AppState { core: core.clone(), sink: sink.clone() });

            tauri::async_runtime::spawn(async move {
                core.start();
                // ~30 fps frame flushing.
                let mut tick = tokio::time::interval(Duration::from_millis(33));
                loop {
                    tick.tick().await;
                    sink.flush();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::subscribe_frames,
            commands::upsert_host,
            commands::remove_host,
            commands::connect_host,
            commands::disconnect_host,
            commands::reconnect_host,
            commands::forget_host_key,
            commands::refresh_tailnet,
            commands::open_external,
            commands::reveal_path,
            commands::vscode_status,
            commands::open_in_vscode,
            commands::set_ui_prefs,
            commands::set_visible_panes,
            commands::stream_pane,
            commands::send_keys,
            commands::send_text,
            commands::paste_text,
            commands::send_input,
            commands::local_shells,
            commands::local_drives,
            commands::set_pane_bell,
            commands::fs_op,
            commands::fs_count,
            commands::git_status,
            commands::read_file,
            commands::read_bytes,
            commands::stat_file,
            commands::git_head,
            commands::write_file,
            commands::quit_app,
            commands::submit_prompt,
            commands::save_paste,
            commands::set_focus,
            commands::set_sound_prefs,
            commands::test_chime,
            commands::integration_status,
            commands::install_integration,
            commands::uninstall_integration,
            commands::ack_pane,
            commands::set_pane_muted,
            commands::create_pane,
            commands::set_pane_hidden,
            commands::create_label,
            commands::update_label,
            commands::delete_label,
            commands::set_pane_labels,
            commands::rename_pane,
            commands::resize_pane,
            commands::release_pane_size,
            commands::terminate_pane,
            commands::list_dir,
            commands::get_ui_state,
            commands::set_ui_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Consuls")
        .run(|app, event| {
            // The UI's layout, zoom and drafts are saved in batches; write what's pending.
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<AppState>()
            {
                state.core.flush_ui_state();
            }
        });
}
