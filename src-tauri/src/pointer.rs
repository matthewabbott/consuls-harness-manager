//! Where the pointer is on the page, for files dragged in from Finder. On macOS the web view runs
//! up under the title bar and the page starts below it, so positions in the web view's own
//! coordinates (Tauri's drop positions, and AppKit's) are that much lower than on the page. This
//! asks AppKit for the pointer in the web view's coordinates and for the web view's height; the
//! page subtracts what its own viewport doesn't cover.

type CmdResult<T> = Result<T, String>;

/// The pointer in the web view's coordinates and the web view's height (points), or `None`
/// where the drop events' own positions are right.
#[tauri::command]
pub async fn pointer_in_page(webview: tauri::Webview) -> CmdResult<Option<(f64, f64, f64)>> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |wv| {
                // SAFETY: on the main thread, with the web view Tauri hands us.
                let _ = tx.send(unsafe { mac::pointer(wv.inner()) });
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSPoint, NSRect};

    /// The mouse in `view`'s coordinates (top-left origin), and the view's height.
    pub unsafe fn pointer(view: *mut std::ffi::c_void) -> Option<(f64, f64, f64)> {
        let view = view as *mut AnyObject;
        if view.is_null() {
            return None;
        }
        let event = AnyClass::get(c"NSEvent")?;
        unsafe {
            let screen: NSPoint = msg_send![event, mouseLocation];
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                return None;
            }
            let in_window: NSPoint = msg_send![window, convertPointFromScreen: screen];
            let in_view: NSPoint = msg_send![view, convertPoint: in_window, fromView: std::ptr::null_mut::<AnyObject>()];
            let flipped: Bool = msg_send![view, isFlipped];
            let bounds: NSRect = msg_send![view, bounds];
            let y = if flipped.as_bool() { in_view.y } else { bounds.size.height - in_view.y };
            Some((in_view.x, y, bounds.size.height))
        }
    }
}
