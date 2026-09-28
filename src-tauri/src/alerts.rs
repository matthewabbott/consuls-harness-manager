//! Surfacing core alerts: synthesized chimes (played from Rust so they work while the
//! window is minimized), Windows toasts that open the pane when clicked, and a taskbar flash.

use std::sync::Mutex;
use std::sync::mpsc::{Sender, channel};

use chm_core::model::{Alert, AlertKind, SoundPrefs};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};
use tracing::warn;

const RATE: u32 = 44_100;

/// One note of a chime: frequency, duration, start offset (seconds), gain.
struct Note(f32, f32, f32, f32);

fn render(notes: &[Note]) -> Vec<f32> {
    let total = notes.iter().map(|n| n.2 + n.1).fold(0.0f32, f32::max) + 0.05;
    let mut out = vec![0.0f32; (total * RATE as f32) as usize];
    for &Note(freq, dur, start, gain) in notes {
        let s0 = (start * RATE as f32) as usize;
        let len = (dur * RATE as f32) as usize;
        for i in 0..len {
            let t = i as f32 / RATE as f32;
            // Soft attack, exponential decay, a touch of octave for a bell-ish timbre.
            let env = (t / 0.006).min(1.0) * (-t * 7.0 / dur).exp();
            let w = (2.0 * std::f32::consts::PI * freq * t).sin() + 0.25 * (4.0 * std::f32::consts::PI * freq * t).sin();
            if let Some(s) = out.get_mut(s0 + i) {
                *s += w * env * gain;
            }
        }
    }
    out
}

fn chime(kind: AlertKind) -> Vec<f32> {
    match kind {
        // Gentle rising two-note "ding-dong": your turn.
        AlertKind::Finished | AlertKind::Summary => render(&[Note(880.0, 0.35, 0.0, 0.18), Note(1318.5, 0.55, 0.11, 0.16)]),
        // Brighter three-note figure: blocked on you.
        AlertKind::NeedsInput => render(&[
            Note(1046.5, 0.25, 0.0, 0.16),
            Note(1046.5, 0.25, 0.12, 0.14),
            Note(1568.0, 0.5, 0.24, 0.16),
        ]),
        // Barely-there tick: a subagent finished.
        AlertKind::Subtask => render(&[Note(740.0, 0.22, 0.0, 0.08)]),
    }
}

/// Starts the audio thread (output streams aren't `Send`, so they live there). The default
/// device is opened per chime: chimes are rare, and this way switching headsets or docking
/// never leaves us writing to a device that's gone.
fn start_audio() -> Sender<(AlertKind, f32)> {
    let (tx, rx) = channel::<(AlertKind, f32)>();
    std::thread::Builder::new()
        .name("consuls-audio".into())
        .spawn(move || {
            while let Ok((kind, volume)) = rx.recv() {
                let sink = match rodio::DeviceSinkBuilder::open_default_sink() {
                    Ok(s) => s,
                    Err(e) => {
                        warn!("no audio output: {e}");
                        continue;
                    }
                };
                let player = rodio::Player::connect_new(sink.mixer());
                let samples: Vec<f32> = chime(kind).into_iter().map(|s| s * volume).collect();
                let channels = std::num::NonZeroU16::new(1).unwrap();
                let rate = std::num::NonZeroU32::new(RATE).unwrap();
                player.append(rodio::buffer::SamplesBuffer::new(channels, rate, samples));
                player.sleep_until_end();
            }
        })
        .expect("spawn audio thread");
    tx
}

/// Loudness curve: the slider is linear, perceived loudness isn't.
fn gain(volume: f32) -> f32 {
    let v = volume.clamp(0.0, 1.0);
    // At full volume, chimes play at roughly twice v1's level (they peak well below clipping).
    v * v * 2.0
}

pub struct Alerter {
    audio: Mutex<Sender<(AlertKind, f32)>>,
    prefs: Mutex<SoundPrefs>,
}

impl Alerter {
    pub fn new() -> Self {
        Self { audio: Mutex::new(start_audio()), prefs: Mutex::new(SoundPrefs::default()) }
    }

    pub fn set_prefs(&self, prefs: SoundPrefs) {
        *self.prefs.lock().unwrap() = prefs;
    }

    /// Plays a chime regardless of the enabled switches (Settings' test buttons).
    pub fn test(&self, kind: AlertKind, volume: f32) {
        let _ = self.audio.lock().unwrap().send((kind, gain(volume)));
    }

    pub fn alert(&self, app: &AppHandle, mut alert: Alert) {
        let prefs = self.prefs.lock().unwrap().clone();
        alert.toast &= prefs.toasts;
        if alert.sound && prefs.allows(alert.kind) {
            let _ = self.audio.lock().unwrap().send((alert.kind, gain(prefs.volume)));
        }
        if alert.flash
            && let Some(w) = app.get_webview_window("main")
        {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
        if alert.toast {
            show_toast(app, &alert);
        }
        // The UI also hears about it (e.g. to pulse the tile).
        let _ = app.emit("alert", &alert);
    }
}

#[cfg(windows)]
fn show_toast(app: &AppHandle, alert: &Alert) {
    use tauri_winrt_notification::Toast;
    // Unpackaged dev builds have no registered AppUserModelID; borrow PowerShell's so the
    // toast still shows. Installed builds use our bundle identifier.
    let app_id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let handle = app.clone();
    let key = alert.key;
    let result = Toast::new(&app_id)
        .title(&alert.title)
        .text1(&alert.body)
        .sound(None) // we play our own chime
        .on_activated(move |_action| {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Some(key) = key {
                let _ = handle.emit("focus-pane", key);
            }
            Ok(())
        })
        .show();
    if let Err(e) = result {
        warn!("toast failed: {e}");
    }
}

#[cfg(not(windows))]
fn show_toast(_app: &AppHandle, _alert: &Alert) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chimes_are_short_and_bounded() {
        for kind in [AlertKind::Finished, AlertKind::NeedsInput, AlertKind::Subtask, AlertKind::Summary] {
            let s = chime(kind);
            assert!(s.len() < RATE as usize, "{kind:?} under a second");
            assert!(s.iter().all(|x| (x * gain(1.0)).abs() <= 1.0), "{kind:?} doesn't clip at full volume");
        }
        assert_eq!(gain(0.0), 0.0);
    }
}
