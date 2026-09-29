//! Tray icon: Consuls keeps watching your agents when its window is closed.

use tauri::image::Image;
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

/// The macOS menu bar's menus: the standard ones, except that Quit (⌘Q) is our own item, so it
/// asks first like the tray's (the stock item ends the app at once; the Dock's Quit still does).
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::Submenu;
    let name = app.package_info().name.clone();
    let quit = MenuItem::with_id(app, APP_QUIT, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?;
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &quit,
        ],
    )?;
    // The webview's text fields need these for ⌘X/⌘C/⌘V/⌘A/⌘Z.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &sep()?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// The app menu's Quit (macOS); not "quit", which the tray's menu uses.
#[cfg(target_os = "macos")]
pub const APP_QUIT: &str = "app-quit";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Harness Manager", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Harness Manager", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    // macOS: a click opens the menu, as menu bar items do. Elsewhere it opens the window.
    let mac = cfg!(target_os = "macos");
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Consul's Harness Manager — watching your agents")
        .menu(&menu)
        .show_menu_on_left_click(mac)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event
                && !mac
            {
                show_main(tray.app_handle());
            }
        });
    if mac {
        builder = builder.icon(menu_bar_icon()).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// The macOS menu bar icon: the app icon's four tiles, the waiting one filled, as a template
/// image (only its alpha counts; macOS tints it for light and dark menu bars). 36 px: 18 pt at 2×.
fn menu_bar_icon() -> Image<'static> {
    const SIZE: u32 = 36;
    const TILE: f32 = 15.0;
    const GAP: f32 = 2.0;
    const RADIUS: f32 = 4.0;
    const STROKE: f32 = 2.0;
    // Signed distance from a rounded square centred at (cx, cy): negative inside.
    let dist = |x: f32, y: f32, cx: f32, cy: f32| {
        let half = TILE / 2.0 - RADIUS;
        let (qx, qy) = ((x - cx).abs() - half, (y - cy).abs() - half);
        qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - RADIUS
    };
    let centre = |i: u32| GAP + TILE / 2.0 + i as f32 * (TILE + GAP);
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for py in 0..SIZE {
        for px in 0..SIZE {
            let (x, y) = (px as f32 + 0.5, py as f32 + 0.5);
            let mut alpha: f32 = 0.0;
            for (col, row) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let d = dist(x, y, centre(col), centre(row));
                let a = if (col, row) == (1, 0) {
                    0.5 - d // filled: the waiting pane
                } else {
                    0.5 - ((d + STROKE / 2.0).abs() - STROKE / 2.0) // outlined
                };
                alpha = alpha.max(a.clamp(0.0, 1.0));
            }
            rgba.extend_from_slice(&[0, 0, 0, (alpha * 255.0).round() as u8]);
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}
