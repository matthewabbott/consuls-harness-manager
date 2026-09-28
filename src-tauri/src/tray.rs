//! Tray icon: Consuls keeps watching your agents when its window is closed.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Quits, unless shells on this PC are still running (quitting ends them): then the window
/// comes up and the UI asks first (it calls `quit_app` to confirm).
pub fn request_quit(app: &AppHandle) {
    let live = app.try_state::<crate::AppState>().map_or(0, |s| s.core.live_local_shells());
    if live == 0 {
        app.exit(0);
        return;
    }
    show_main(app);
    let _ = app.emit("confirm-quit", live);
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Harness Manager", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Harness Manager", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Consul's Harness Manager — watching your agents")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
