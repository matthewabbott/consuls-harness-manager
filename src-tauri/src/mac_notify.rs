//! Notification Center on macOS (UNUserNotificationCenter). Clicking a notification brings the
//! window up and opens its pane, like a Windows toast. Only an app bundle (`Consuls.app`) may post
//! them — the framework throws for a bare binary — so `tauri dev` just plays the chime.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{ClassType, define_class, msg_send};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

/// Set once notifications can be posted.
static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class doesn't implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "ConsulsNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Shown while the app is in front too: the core only asks for one when it's useful.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, handler: &block2::DynBlock<dyn Fn()>) {
            clicked(&response.notification().request().identifier().to_string());
            handler.call(());
        }
    }
);

/// Whether this process may use Notification Center: only as an app bundle.
fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

/// Sets up the click handler and asks for permission (macOS asks the user once).
pub fn init(app: &AppHandle) {
    if !bundled() {
        info!("not running as Consuls.app: no Notification Center, chimes only");
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    // SAFETY: `new` on an NSObject subclass without ivars.
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; this one lives as long as the app.
    std::mem::forget(delegate);
    let answered = RcBlock::new(|granted: Bool, _error: *mut NSError| {
        if !granted.as_bool() {
            warn!("notifications aren't allowed (System Settings → Notifications → Consuls)");
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &answered);
    let _ = APP.set(app.clone());
}

/// Posts a notification; clicking it opens pane `key`. Silent: the app plays its own chime.
pub fn show(title: &str, body: &str, key: Option<u32>) {
    if APP.get().is_none() {
        return;
    }
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let id = match key {
        Some(key) => format!("pane-{key}-{n}"),
        None => format!("note-{n}"),
    };
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
    let done = RcBlock::new(|error: *mut NSError| {
        // SAFETY: the framework passes null or a valid NSError.
        if let Some(error) = unsafe { error.as_ref() } {
            warn!("notification failed: {}", error.localizedDescription());
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
}

/// A notification was clicked: bring the window up on its pane.
fn clicked(id: &str) {
    let Some(app) = APP.get() else { return };
    crate::tray::show_main(app);
    if let Some(key) = id.strip_prefix("pane-").and_then(|rest| rest.split('-').next()).and_then(|k| k.parse::<u32>().ok()) {
        let _ = app.emit("focus-pane", key);
    }
}
