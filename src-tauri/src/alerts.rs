//! Surfacing core alerts: synthesized chimes (played from Rust so they work while the
//! window is minimized), Windows toasts / macOS notifications that open the pane when clicked,
//! and a taskbar flash (a Dock bounce on macOS). On the iPhone only the UI hears about them:
//! the app runs only while it's on screen, and pushes come from the notifiers.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
#[cfg(desktop)]
use std::time::{Duration, Instant};

use chm_core::model::{Alert, AlertKind, SoundPrefs};
#[cfg(desktop)]
use tauri::{Manager, UserAttentionType};
use tauri::{AppHandle, Emitter};
#[cfg(desktop)]
use tracing::warn;

#[cfg(desktop)]
/// One note of a chime: frequency, duration, start offset (seconds), gain.
struct Note(f32, f32, f32, f32);

#[cfg(desktop)]
fn render(notes: &[Note], rate: u32) -> Vec<f32> {
    let rate = rate as f32;
    let total = notes.iter().map(|n| n.2 + n.1).fold(0.0f32, f32::max) + 0.05;
    let mut out = vec![0.0f32; (total * rate) as usize];
    for &Note(freq, dur, start, gain) in notes {
        let s0 = (start * rate) as usize;
        let len = (dur * rate) as usize;
        for i in 0..len {
            let t = i as f32 / rate;
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

#[cfg(desktop)]
/// A chime as mono samples at `rate`.
fn chime(kind: AlertKind, rate: u32) -> Vec<f32> {
    match kind {
        // Gentle rising two-note "ding-dong": your turn.
        AlertKind::Finished | AlertKind::Summary => render(&[Note(880.0, 0.35, 0.0, 0.18), Note(1318.5, 0.55, 0.11, 0.16)], rate),
        // Brighter three-note figure: blocked on you.
        AlertKind::NeedsInput => render(
            &[Note(1046.5, 0.25, 0.0, 0.16), Note(1046.5, 0.25, 0.12, 0.14), Note(1568.0, 0.5, 0.24, 0.16)],
            rate,
        ),
        // Barely-there tick: a subagent finished.
        AlertKind::Subtask => render(&[Note(740.0, 0.22, 0.0, 0.08)], rate),
        // A single clear bell: somebody pinged you (IRC highlight, …).
        AlertKind::Bell => render(&[Note(1568.0, 0.6, 0.0, 0.15), Note(2349.3, 0.4, 0.0, 0.05)], rate),
    }
}

#[cfg(desktop)]
fn length(samples: &[f32], rate: u32) -> Duration {
    Duration::from_secs_f64(samples.len() as f64 / rate as f64)
}

#[cfg(desktop)]
const KINDS: [AlertKind; 5] = [AlertKind::Finished, AlertKind::NeedsInput, AlertKind::Subtask, AlertKind::Summary, AlertKind::Bell];

#[cfg(desktop)]
/// At most this many chimes of one kind per pane are waiting or playing; more are dropped, so a
/// burst never becomes a backlog.
const PER_KIND: usize = 2;

#[cfg(desktop)]
/// The least time between the starts of any two chimes: a burst from many panes ripples instead
/// of landing as one blob.
const STAGGER: Duration = Duration::from_millis(150);

#[cfg(desktop)]
/// Decides when each chime starts, if at all. A pane's chimes play one after another; different
/// panes' may overlap.
#[derive(Default)]
struct Schedule {
    chimes: Vec<Slot>,
}

#[cfg(desktop)]
struct Slot {
    pane: Option<u32>,
    kind: AlertKind,
    start: Instant,
    end: Instant,
}

#[cfg(desktop)]
impl Schedule {
    /// When a chime `len` long for `pane` should start, or `None` to drop it. Alerts without a
    /// pane (summaries, Settings' tests) share a lane of their own.
    fn add(&mut self, pane: Option<u32>, kind: AlertKind, len: Duration, now: Instant) -> Option<Instant> {
        // Chimes that ended are forgotten, unless their start still spaces out the next one.
        self.chimes.retain(|c| c.end > now || c.start + STAGGER > now);
        let lane = || self.chimes.iter().filter(|c| c.pane == pane && c.end > now);
        if lane().filter(|c| c.kind == kind).count() >= PER_KIND {
            return None;
        }
        let mut start = lane().map(|c| c.end).fold(now, Instant::max);
        let mut starts: Vec<Instant> = self.chimes.iter().map(|c| c.start).collect();
        starts.sort();
        for s in starts {
            if start + STAGGER <= s {
                break;
            }
            if s + STAGGER > start {
                start = s + STAGGER;
            }
        }
        self.chimes.push(Slot { pane, kind, start, end: start + len });
        Some(start)
    }
}

#[cfg(desktop)]
/// How long the output stays open after the last chime ends. A burst shares one device; between
/// bursts nothing holds it (an open stream counts as audio playing, which can keep the machine
/// awake), and the next burst goes to whatever the default device is by then.
const LINGER: Duration = Duration::from_secs(5);

#[cfg(desktop)]
/// The default output device, open while chimes are due.
struct Output {
    sink: rodio::MixerDeviceSink,
    /// Rendered at the device's rate: the mixer resamples in pieces, and a leading delay could
    /// put a seam (a click) inside a chime.
    chimes: Vec<(AlertKind, Vec<f32>)>,
    /// Set when the stream fails (e.g. the device was unplugged): the next chime reopens.
    failed: std::sync::Arc<AtomicBool>,
    until: Instant,
}

#[cfg(desktop)]
impl Output {
    fn open() -> Result<Self, rodio::DeviceSinkError> {
        let failed = std::sync::Arc::new(AtomicBool::new(false));
        let flag = failed.clone();
        let mut sink = rodio::DeviceSinkBuilder::from_default_device()?
            .with_error_callback(move |e| {
                if !matches!(e, rodio::cpal::StreamError::BufferUnderrun) && !flag.swap(true, Ordering::Relaxed) {
                    warn!("audio output failed: {e}");
                }
            })
            .open_sink_or_fallback()?;
        sink.log_on_drop(false);
        let rate = sink.config().sample_rate().get();
        let chimes = KINDS.iter().map(|&k| (k, chime(k, rate))).collect();
        Ok(Self { sink, chimes, failed, until: Instant::now() })
    }

    fn usable(&self) -> bool {
        !self.failed.load(Ordering::Relaxed)
    }

    /// A chime's samples, and how long it lasts.
    fn chime(&self, kind: AlertKind) -> (&[f32], Duration) {
        let samples = &self.chimes.iter().find(|(k, _)| *k == kind).expect("every kind has a chime").1;
        (samples, length(samples, self.sink.config().sample_rate().get()))
    }

    /// Mixes in mono `samples` to start at `start`, and keeps the device until a while after.
    fn play(&mut self, samples: Vec<f32>, start: Instant, len: Duration) {
        use rodio::Source;
        let rate = self.sink.config().sample_rate();
        let wait = start.saturating_duration_since(Instant::now());
        self.sink.mixer().add(rodio::buffer::SamplesBuffer::new(std::num::NonZeroU16::MIN, rate, samples).delay(wait));
        self.until = self.until.max(start + len + LINGER);
    }
}

/// A chime to play: for which pane (`None`: summaries and Settings' tests), what, how loud.
#[cfg_attr(mobile, allow(dead_code))]
struct Cue {
    pane: Option<u32>,
    kind: AlertKind,
    gain: f32,
}

#[cfg(desktop)]
/// Starts the audio thread (output streams aren't `Send`, so they live there). Cues wait in the
/// channel only while it opens a device; when it's full they're dropped, like the schedule's
/// extras.
fn start_audio() -> SyncSender<Cue> {
    use std::sync::mpsc::RecvTimeoutError;

    let (tx, rx) = sync_channel::<Cue>(64);
    std::thread::Builder::new()
        .name("consuls-audio".into())
        .spawn(move || {
            let mut schedule = Schedule::default();
            let mut output: Option<Output> = None;
            loop {
                let cue = match &output {
                    Some(out) => match rx.recv_timeout(out.until.saturating_duration_since(Instant::now())) {
                        Ok(cue) => cue,
                        Err(RecvTimeoutError::Timeout) => {
                            output = None;
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => return,
                    },
                    None => match rx.recv() {
                        Ok(cue) => cue,
                        Err(_) => return,
                    },
                };
                // Opened before scheduling, so the time that takes doesn't eat into the schedule.
                if !output.as_ref().is_some_and(Output::usable) {
                    output = Output::open().inspect_err(|e| warn!("no audio output: {e}")).ok();
                }
                let Some(out) = &mut output else { continue };
                let (samples, len) = out.chime(cue.kind);
                let Some(start) = schedule.add(cue.pane, cue.kind, len, Instant::now()) else { continue };
                let samples = samples.iter().map(|s| s * cue.gain).collect();
                out.play(samples, start, len);
            }
        })
        .expect("spawn audio thread");
    tx
}

#[cfg(mobile)]
fn start_audio() -> SyncSender<Cue> {
    sync_channel(0).0
}

/// Loudness curve: the slider is linear, perceived loudness isn't.
fn gain(volume: f32) -> f32 {
    let v = volume.clamp(0.0, 1.0);
    // At full volume, chimes play at roughly twice v1's level (they peak well below clipping).
    v * v * 2.0
}

pub struct Alerter {
    audio: SyncSender<Cue>,
    prefs: Mutex<SoundPrefs>,
    /// Recording mode: toasts don't name the pane or the machine.
    recording: AtomicBool,
}

impl Alerter {
    pub fn new() -> Self {
        Self { audio: start_audio(), prefs: Mutex::new(SoundPrefs::default()), recording: AtomicBool::new(false) }
    }

    pub fn set_prefs(&self, prefs: SoundPrefs) {
        *self.prefs.lock().unwrap() = prefs;
    }

    pub fn set_recording(&self, on: bool) {
        self.recording.store(on, Ordering::Relaxed);
    }

    /// Plays a chime regardless of the enabled switches (Settings' test buttons).
    pub fn test(&self, kind: AlertKind, volume: f32) {
        let _ = self.audio.try_send(Cue { pane: None, kind, gain: gain(volume) });
    }

    pub fn alert(&self, app: &AppHandle, mut alert: Alert) {
        let prefs = self.prefs.lock().unwrap().clone();
        alert.toast &= prefs.toasts;
        if alert.sound && prefs.allows(alert.kind) {
            let _ = self.audio.try_send(Cue { pane: alert.key, kind: alert.kind, gain: gain(prefs.volume) });
        }
        #[cfg(desktop)]
        if alert.flash
            && let Some(w) = app.get_webview_window(&app.state::<crate::AppState>().sink.windows.window_for(None))
        {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
        if alert.toast {
            if self.recording.load(Ordering::Relaxed) {
                show_toast(app, &anonymous(&alert));
            } else {
                show_toast(app, &alert);
            }
        }
        // The UI also hears about it (e.g. to pulse the tile).
        let _ = app.emit("alert", &alert);
    }
}

/// The toast for recording mode: what happened, not where (titles and machine names can be
/// personal).
fn anonymous(alert: &Alert) -> Alert {
    let title = match alert.kind {
        AlertKind::NeedsInput => "A pane needs your input",
        AlertKind::Bell => "A pane rang its bell",
        AlertKind::Subtask => "A subtask finished",
        AlertKind::Finished | AlertKind::Summary => "A pane is waiting for you",
    };
    Alert { title: title.into(), body: "Recording mode is on.".into(), ..alert.clone() }
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
            crate::windows::show_pane(&handle, key);
            Ok(())
        })
        .show();
    if let Err(e) = result {
        warn!("toast failed: {e}");
    }
}

#[cfg(target_os = "macos")]
fn show_toast(_app: &AppHandle, alert: &Alert) {
    crate::mac_notify::show(&alert.title, &alert.body, alert.key);
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_toast(_app: &AppHandle, _alert: &Alert) {}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    #[test]
    fn chimes_are_short_and_bounded() {
        for rate in [44_100, RATE] {
            for kind in KINDS {
                let s = chime(kind, rate);
                assert!(s.len() < rate as usize, "{kind:?} under a second");
                assert!(s.iter().all(|x| (x * gain(1.0)).abs() <= 1.0), "{kind:?} doesn't clip at full volume");
            }
        }
        assert_eq!(gain(0.0), 0.0);
    }

    fn len(kind: AlertKind) -> Duration {
        length(&chime(kind, RATE), RATE)
    }

    /// Feeds alerts that all arrive at `now`; returns the start of each one that plays.
    fn burst(schedule: &mut Schedule, now: Instant, alerts: &[(Option<u32>, AlertKind)]) -> Vec<Option<Instant>> {
        alerts.iter().map(|&(pane, kind)| schedule.add(pane, kind, len(kind), now)).collect()
    }

    fn assert_staggered(starts: &[Instant]) {
        let mut starts = starts.to_vec();
        starts.sort();
        for w in starts.windows(2) {
            assert!(w[1] - w[0] >= STAGGER, "starts {:?} apart", w[1] - w[0]);
        }
    }

    #[test]
    fn a_burst_from_one_pane_plays_two_back_to_back() {
        let mut s = Schedule::default();
        let t0 = Instant::now();
        let finished = len(AlertKind::Finished);
        let got = burst(&mut s, t0, &[(Some(1), AlertKind::Finished); 10]);
        assert_eq!(got[0], Some(t0));
        assert_eq!(got[1], Some(t0 + finished));
        assert!(got[2..].iter().all(Option::is_none), "the rest are dropped: {got:?}");

        // Once the first has played, one more may wait behind the second.
        let later = t0 + finished + Duration::from_millis(10);
        assert_eq!(s.add(Some(1), AlertKind::Finished, finished, later), Some(t0 + finished * 2));
        assert_eq!(s.add(Some(1), AlertKind::Finished, finished, later), None);

        // Nothing is remembered once it's all over.
        let quiet = t0 + finished * 3;
        assert_eq!(s.add(Some(1), AlertKind::Finished, finished, quiet), Some(quiet));
        assert_eq!(s.chimes.len(), 1);
    }

    #[test]
    fn bursts_from_several_panes_overlap_staggered() {
        let mut s = Schedule::default();
        let t0 = Instant::now();
        let finished = len(AlertKind::Finished);
        let alerts: Vec<_> = (1..=3).flat_map(|pane| [(Some(pane), AlertKind::Finished); 5]).collect();
        let got = burst(&mut s, t0, &alerts);
        let mut all = Vec::new();
        for (pane, starts) in got.chunks(5).enumerate() {
            let played: Vec<Instant> = starts.iter().flatten().copied().collect();
            assert_eq!(played.len(), 2, "pane {pane}: {starts:?}");
            assert!(played[1] >= played[0] + finished, "pane {pane}'s chimes don't overlap");
            all.extend(played);
        }
        assert_staggered(&all);
        // Each pane's first chime starts while the one before is still playing.
        let firsts: Vec<Instant> = got.chunks(5).map(|c| c[0].unwrap()).collect();
        assert_eq!(firsts, [t0, t0 + STAGGER, t0 + STAGGER * 2]);
        assert!(firsts[2] < firsts[0] + finished);
    }

    #[test]
    fn each_kind_gets_its_own_two() {
        let mut s = Schedule::default();
        let t0 = Instant::now();
        let kinds = [AlertKind::Finished, AlertKind::NeedsInput, AlertKind::Bell];
        let alerts: Vec<_> = (0..5).flat_map(|_| kinds.map(|k| (Some(7), k))).collect();
        let got = burst(&mut s, t0, &alerts);
        for kind in kinds {
            let n = alerts.iter().zip(&got).filter(|((_, k), start)| *k == kind && start.is_some()).count();
            assert_eq!(n, 2, "{kind:?}");
        }
        // One after another.
        let mut played: Vec<(Instant, AlertKind)> =
            alerts.iter().zip(&got).filter_map(|((_, k), start)| start.map(|t| (t, *k))).collect();
        played.sort_by_key(|p| p.0);
        assert_eq!(played[0].0, t0);
        for w in played.windows(2) {
            assert_eq!(w[1].0, w[0].0 + len(w[0].1));
        }
    }

    #[test]
    fn alerts_without_a_pane_are_a_pane_of_their_own() {
        let mut s = Schedule::default();
        let t0 = Instant::now();
        let got = burst(
            &mut s,
            t0,
            &[(Some(1), AlertKind::Finished), (None, AlertKind::Finished), (None, AlertKind::Finished), (None, AlertKind::Finished)],
        );
        assert_eq!(got[1], Some(t0 + STAGGER), "overlaps pane 1's");
        assert_eq!(got[2], Some(t0 + STAGGER + len(AlertKind::Finished)));
        assert_eq!(got[3], None);
    }

    #[test]
    fn recording_mode_toasts_name_nothing() {
        let alert = Alert {
            key: Some(3),
            kind: AlertKind::NeedsInput,
            title: "consulear@spark-d683: Claude needs you".into(),
            body: "Allow Bash(rm -rf /home/consulear/x)? · spark-d683".into(),
            sound: true,
            toast: true,
            flash: true,
        };
        let a = anonymous(&alert);
        assert_eq!(a.title, "A pane needs your input");
        assert!(!a.body.contains("consulear") && !a.body.contains("spark"));
        assert_eq!(a.key, Some(3), "clicking it still opens the pane");
    }
}
