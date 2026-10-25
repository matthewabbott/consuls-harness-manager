//! Dictation: speech to text with Fluid Speech Mini (FluidVoice's English model, 0.6B, from
//! NVIDIA's Parakeet v3; CC BY 4.0) through parakeet.cpp's command-line tool, both in `stt/` in
//! the install folder (`scripts/server.sh` builds the tool on the Mac and fetches the model).
//!
//! The phone sends what you say in pieces cut at your pauses, streaming each piece's audio while
//! you talk (`append`); with memory to spare it asks for a draft of the piece so far about once a
//! second (`draft`), and the piece's final text when it ends (`finish`). Each run starts the
//! engine, which reads the whole model into memory, transcribes, and exits: nothing stays loaded
//! between runs (a run costs ~0.25 s more than its audio's share).
//! Memory grows with a piece's length (on a Spark: 364 MB for 1 s, 507 MB for 20 s, 1.5 GB for two
//! minutes in one go), so how long pieces may be follows how much memory the machine has free
//! (`level`). The engine is the first thing the kernel kills when memory runs out
//! (`oom_score_adj` 1000), runs at a lower priority than everything else of yours (nice 10), and
//! one piece is transcribed at a time.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use ts_rs::TS;

pub const ENGINE: &str = "parakeet-cli";
pub const MODEL: &str = "fluid-speech-mini-q2k-q4k.gguf";
/// The longest piece taken, in seconds.
const MAX_SECS: f64 = 180.0;
/// Pieces being streamed that are kept at once, and for how long one is kept untouched.
const MAX_PIECES: usize = 8;
const PIECE_TTL: Duration = Duration::from_secs(120);

/// How much memory the machine has for dictation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MemLevel {
    /// Plenty: pieces up to 30 s.
    Green,
    /// Tight: shorter pieces.
    Yellow,
    /// Very low: short pieces only.
    Red,
    /// Not enough for even a short piece.
    Out,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SttStatus {
    /// The engine and the model are here.
    pub installed: bool,
    /// Memory the machine has for new work (`MemAvailable`), MB; null where it can't tell.
    #[ts(type = "number | null")]
    pub available_mb: Option<u64>,
    pub level: MemLevel,
    /// The longest piece to send, in seconds (0: none).
    pub max_piece_secs: u32,
    /// The pause that ends a piece, in milliseconds.
    pub pause_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Transcription {
    pub text: String,
    /// As it is after this piece, for the next ones.
    pub status: SttStatus,
}

#[derive(Debug)]
pub enum SttError {
    NotInstalled,
    BadAudio(String),
    NoMemory { need_mb: u64, available_mb: u64 },
    /// The piece's audio doesn't reach where the new audio goes (lost, or the server restarted).
    Gap { have: usize },
    Failed(String),
}

impl std::fmt::Display for SttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SttError::NotInstalled => write!(f, "dictation isn't installed on this server (scripts/server.sh restart installs it)"),
            SttError::BadAudio(why) => write!(f, "{why}"),
            SttError::NoMemory { need_mb, available_mb } => {
                write!(f, "not enough memory for dictation: this piece needs about {need_mb} MB, {available_mb} MB is free")
            }
            SttError::Gap { have } => write!(f, "this piece's audio isn't all here (the server has {have} samples of it)"),
            SttError::Failed(why) => write!(f, "transcribing failed: {why}"),
        }
    }
}

/// MB a piece of `secs` seconds takes while transcribed (fitted to measurements on a Spark; the
/// model's attention makes long pieces grow faster than their length).
pub fn need_mb(secs: f64) -> u64 {
    (364.0 + 8.0 * secs + 0.033 * (secs - 30.0).max(0.0).powi(2)).ceil() as u64
}

/// What `available_mb` allows: the level, the longest piece (s) and the pause that ends one (ms).
pub fn level(available_mb: Option<u64>) -> (MemLevel, u32, u32) {
    match available_mb {
        Some(a) if a < 450 => (MemLevel::Out, 0, 0),
        Some(a) if a < 600 => (MemLevel::Red, 8, 250),
        Some(a) if a < 1024 => (MemLevel::Yellow, 15, 400),
        _ => (MemLevel::Green, 30, 700),
    }
}

/// `MemAvailable` from `/proc/meminfo`, in MB.
pub fn parse_available(meminfo: &str) -> Option<u64> {
    let kb = meminfo.lines().find_map(|l| l.strip_prefix("MemAvailable:"))?;
    kb.trim().trim_end_matches("kB").trim().parse::<u64>().ok().map(|kb| kb / 1024)
}

fn available_mb() -> Option<u64> {
    parse_available(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

/// The length in seconds of a WAV file of 16 kHz mono 16-bit PCM, the only kind taken.
pub fn wav_secs(b: &[u8]) -> Result<f64, String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let mut i = 12;
    let mut format = false;
    while i + 8 <= b.len() {
        let len = u32_at(i + 4) as usize;
        let body = i + 8;
        match &b[i..i + 4] {
            b"fmt " => {
                if len < 16 || body + 16 > b.len() {
                    return Err("a broken WAV file".into());
                }
                if u16_at(body) != 1 || u16_at(body + 2) != 1 || u32_at(body + 4) != 16_000 || u16_at(body + 14) != 16 {
                    return Err("the audio must be 16 kHz mono 16-bit PCM".into());
                }
                format = true;
            }
            b"data" if format => return Ok(len.min(b.len() - body) as f64 / 32_000.0),
            b"data" => return Err("a broken WAV file".into()),
            _ => {}
        }
        i = body.saturating_add(len).saturating_add(len & 1);
    }
    Err("no audio in the WAV file".into())
}

/// 16 kHz mono 16-bit PCM (little-endian) in a WAV file.
pub fn wav(pcm: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(44 + pcm.len());
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    b.extend_from_slice(pcm);
    b
}

/// A piece whose audio is arriving: its PCM so far.
struct Piece {
    pcm: Vec<u8>,
    touched: Instant,
}

pub struct Stt {
    dir: PathBuf,
    turn: tokio::sync::Mutex<()>,
    pieces: Mutex<HashMap<String, Piece>>,
}

impl Stt {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, turn: Default::default(), pieces: Default::default() }
    }

    fn installed(&self) -> bool {
        self.dir.join(ENGINE).is_file() && self.dir.join(MODEL).is_file()
    }

    pub fn status(&self) -> SttStatus {
        let available_mb = available_mb();
        let (level, max_piece_secs, pause_ms) = level(available_mb);
        SttStatus { installed: self.installed(), available_mb, level, max_piece_secs, pause_ms }
    }

    /// Adds audio (16 kHz mono 16-bit PCM) to the piece `id` at sample `at`. Audio already there
    /// from `at` on is replaced: the phone may cut a piece before the end of what it sent, and
    /// sending the same audio again changes nothing.
    pub fn append(&self, id: &str, at: usize, pcm: &[u8]) -> Result<(), SttError> {
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(SttError::BadAudio("a piece needs a short name of letters, digits, - and _".into()));
        }
        if !pcm.len().is_multiple_of(2) {
            return Err(SttError::BadAudio("the audio must be 16-bit samples".into()));
        }
        if (at * 2 + pcm.len()) as f64 / 32_000.0 > MAX_SECS {
            return Err(SttError::BadAudio("pieces are limited to three minutes".into()));
        }
        let mut pieces = self.pieces.lock().unwrap();
        pieces.retain(|_, p| p.touched.elapsed() < PIECE_TTL);
        if !pieces.contains_key(id) && pieces.len() >= MAX_PIECES
            && let Some(oldest) = pieces.iter().min_by_key(|(_, p)| p.touched).map(|(k, _)| k.clone())
        {
            pieces.remove(&oldest);
        }
        let p = pieces.entry(id.to_string()).or_insert_with(|| Piece { pcm: Vec::new(), touched: Instant::now() });
        let have = p.pcm.len() / 2;
        if at > have {
            return Err(SttError::Gap { have });
        }
        p.pcm.truncate(at * 2);
        p.pcm.extend_from_slice(pcm);
        p.touched = Instant::now();
        Ok(())
    }

    /// The text of the piece `id` so far, if the engine is free and memory is plentiful (a draft
    /// must never hold up a piece's final text, nor take memory that's short); None otherwise.
    pub async fn draft(&self, id: &str) -> Result<Option<Transcription>, SttError> {
        if !self.installed() {
            return Err(SttError::NotInstalled);
        }
        let Ok(_turn) = self.turn.try_lock() else { return Ok(None) };
        let Some(pcm) = self.pieces.lock().unwrap().get(id).map(|p| p.pcm.clone()) else { return Ok(None) };
        let secs = pcm.len() as f64 / 32_000.0;
        let available = available_mb();
        if level(available).0 != MemLevel::Green || available.is_some_and(|a| a < need_mb(secs).max(1024)) {
            return Ok(None);
        }
        self.run(wav(&pcm), secs).await.map(Some)
    }

    /// The piece `id`'s text, once all its audio is here; the piece is then forgotten.
    pub async fn finish(&self, id: &str) -> Result<Transcription, SttError> {
        let pcm = self.pieces.lock().unwrap().remove(id).map(|p| p.pcm).ok_or(SttError::Gap { have: 0 })?;
        self.transcribe(wav(&pcm)).await
    }

    /// One piece of speech (a WAV file, as `wav_secs` takes) as text.
    pub async fn transcribe(&self, wav: Vec<u8>) -> Result<Transcription, SttError> {
        if !self.installed() {
            return Err(SttError::NotInstalled);
        }
        let secs = wav_secs(&wav).map_err(SttError::BadAudio)?;
        if secs > MAX_SECS {
            return Err(SttError::BadAudio("pieces are limited to three minutes".into()));
        }
        let _turn = self.turn.lock().await;
        self.run(wav, secs).await
    }

    /// Runs the engine on `wav`, with the turn held.
    async fn run(&self, wav: Vec<u8>, secs: f64) -> Result<Transcription, SttError> {
        // Checked once it's this piece's turn: the one before has given its memory back.
        let need_mb = need_mb(secs);
        if let Some(available_mb) = available_mb()
            && available_mb < need_mb.max(450)
        {
            return Err(SttError::NoMemory { need_mb, available_mb });
        }
        // Where there's no /proc (a Mac, in development), it runs without the OOM preference.
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "echo 1000 >/proc/self/oom_score_adj 2>/dev/null; exec nice -n 10 \"$0\" \"$@\""])
            .arg(self.dir.join(ENGINE))
            .args(["transcribe", "--model"])
            .arg(self.dir.join(MODEL))
            .args(["--input", "-", "--threads", "4"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| SttError::Failed(format!("couldn't start the engine: {e}")))?;
        let mut stdin = child.stdin.take().expect("piped");
        tokio::spawn(async move {
            let _ = stdin.write_all(&wav).await;
        });
        let limit = Duration::from_secs(30 + 2 * secs as u64);
        let out = match tokio::time::timeout(limit, child.wait_with_output()).await {
            Ok(out) => out.map_err(|e| SttError::Failed(e.to_string()))?,
            Err(_) => return Err(SttError::Failed(format!("no text after {} s", limit.as_secs()))),
        };
        if !out.status.success() {
            use std::os::unix::process::ExitStatusExt;
            let stderr = String::from_utf8_lossy(&out.stderr);
            let why = match out.status.signal() {
                Some(9) => "the engine was killed (out of memory?)".to_string(),
                _ => stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("the engine failed").trim().to_string(),
            };
            return Err(SttError::Failed(why));
        }
        let text = String::from_utf8_lossy(&out.stdout).split_whitespace().collect::<Vec<_>>().join(" ");
        Ok(Transcription { text, status: self.status() })
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn silence(secs: f64) -> Vec<u8> {
        wav(&vec![0; (secs * 32_000.0) as usize])
    }

    #[test]
    fn reads_wav_length() {
        assert_eq!(wav_secs(&silence(2.5)), Ok(2.5));
        assert!(wav_secs(b"RIFF....WAVE").is_err());
        let mut stereo = silence(1.0);
        stereo[22] = 2;
        assert_eq!(wav_secs(&stereo), Err("the audio must be 16 kHz mono 16-bit PCM".into()));
        assert!(wav_secs(b"not a wav at all").is_err());
    }

    #[test]
    fn memory_levels() {
        assert_eq!(level(Some(115_000)), (MemLevel::Green, 30, 700));
        assert_eq!(level(Some(1024)), (MemLevel::Green, 30, 700));
        assert_eq!(level(Some(800)), (MemLevel::Yellow, 15, 400));
        assert_eq!(level(Some(500)), (MemLevel::Red, 8, 250));
        assert_eq!(level(Some(449)).0, MemLevel::Out);
        assert_eq!(level(None).0, MemLevel::Green);
        // Each level's longest piece fits in its least memory.
        assert!(need_mb(30.0) <= 1024 && need_mb(15.0) <= 600 && need_mb(8.0) <= 450);
        // Close to what was measured.
        assert!((need_mb(114.0) as i64 - 1509).abs() < 50);
    }

    #[test]
    fn parses_meminfo() {
        let m = "MemTotal:       125489664 kB\nMemFree:        96072704 kB\nMemAvailable:   118203392 kB\n";
        assert_eq!(parse_available(m), Some(115_433));
        assert_eq!(parse_available("MemTotal: 1 kB\n"), None);
    }

    /// A stand-in engine in a scratch folder: checks its arguments, reads the audio from stdin,
    /// and prints how many bytes it got.
    fn fake_engine(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("chm-stt-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = dir.join(ENGINE);
        std::fs::write(
            &engine,
            "#!/bin/sh\n[ \"$1 $4 $5 $6 $7\" = \"transcribe --input - --threads 4\" ] || { echo bad args >&2; exit 2; }\n\
             n=$(wc -c | tr -d ' ')\necho \"  heard $n bytes\n\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join(MODEL), b"").unwrap();
        dir
    }

    #[tokio::test]
    async fn runs_the_engine() {
        let empty = std::env::temp_dir().join(format!("chm-stt-none-{}", std::process::id()));
        assert!(matches!(Stt::new(empty).transcribe(silence(1.0)).await, Err(SttError::NotInstalled)));

        let dir = fake_engine("run");
        let stt = Stt::new(dir.clone());
        let t = stt.transcribe(silence(1.0)).await.unwrap();
        assert_eq!(t.text, format!("heard {} bytes", 44 + 32_000));
        assert!(t.status.installed);

        std::fs::write(dir.join(ENGINE), "#!/bin/sh\necho 'model not found' >&2\nexit 1\n").unwrap();
        assert!(matches!(stt.transcribe(silence(1.0)).await, Err(SttError::Failed(why)) if why == "model not found"));
        assert!(matches!(stt.transcribe(b"nope".to_vec()).await, Err(SttError::BadAudio(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Drafts need plenty of free memory: true on a Mac (no /proc) and on any machine fit to run this.
    #[tokio::test]
    async fn streams_pieces() {
        let dir = fake_engine("stream");
        let stt = Stt::new(dir.clone());
        // Audio arrives in parts; what's sent again from an earlier sample replaces what was there.
        stt.append("p1", 0, &[0; 3200]).unwrap();
        stt.append("p1", 1600, &[0; 3200]).unwrap();
        assert!(matches!(stt.append("p1", 5000, &[0; 2]), Err(SttError::Gap { have: 3200 })));
        let d = stt.draft("p1").await.unwrap().expect("a draft");
        assert_eq!(d.text, format!("heard {} bytes", 44 + 6400));
        // Cut before the end of what was sent: the piece ends there.
        stt.append("p1", 1000, &[]).unwrap();
        assert_eq!(stt.finish("p1").await.unwrap().text, format!("heard {} bytes", 44 + 2000));
        assert!(matches!(stt.finish("p1").await, Err(SttError::Gap { have: 0 })));
        assert!(stt.draft("p1").await.unwrap().is_none());

        // A draft never waits for the engine.
        stt.append("p2", 0, &[0; 2]).unwrap();
        let turn = stt.turn.lock().await;
        assert!(stt.draft("p2").await.unwrap().is_none());
        drop(turn);

        assert!(matches!(stt.append("not ok!", 0, &[]), Err(SttError::BadAudio(_))));
        assert!(matches!(stt.append("p3", 0, &[0; 3]), Err(SttError::BadAudio(_))));
        assert!(matches!(stt.append("p3", 180 * 16_000, &[0; 2]), Err(SttError::BadAudio(_))));
        // Only so many pieces are kept: the oldest goes.
        for i in 0..MAX_PIECES {
            stt.append(&format!("q{i}"), 0, &[0; 2]).unwrap();
        }
        assert!(matches!(stt.append("p2", 1, &[]), Err(SttError::Gap { have: 0 })));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
