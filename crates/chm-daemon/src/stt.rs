//! Dictation: speech to text with Fluid Speech Mini (FluidVoice's English model, 0.6B, from
//! NVIDIA's Parakeet v3; CC BY 4.0) through parakeet.cpp's command-line tool, both in `stt/` in
//! the install folder (`scripts/server.sh` builds the tool on the Mac and fetches the model).
//!
//! The phone sends what you say in pieces cut at your pauses. Each piece starts the engine, which
//! reads the whole model into memory, transcribes, and exits: nothing stays loaded between pieces.
//! Memory grows with a piece's length (on a Spark: 364 MB for 1 s, 507 MB for 20 s, 1.5 GB for two
//! minutes in one go), so how long pieces may be follows how much memory the machine has free
//! (`level`). The engine is the first thing the kernel kills when memory runs out
//! (`oom_score_adj` 1000), runs at a lower priority than everything else of yours (nice 10), and
//! one piece is transcribed at a time.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use ts_rs::TS;

pub const ENGINE: &str = "parakeet-cli";
pub const MODEL: &str = "fluid-speech-mini-q2k-q4k.gguf";

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

pub struct Stt {
    dir: PathBuf,
    turn: tokio::sync::Mutex<()>,
}

impl Stt {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, turn: Default::default() }
    }

    fn installed(&self) -> bool {
        self.dir.join(ENGINE).is_file() && self.dir.join(MODEL).is_file()
    }

    pub fn status(&self) -> SttStatus {
        let available_mb = available_mb();
        let (level, max_piece_secs, pause_ms) = level(available_mb);
        SttStatus { installed: self.installed(), available_mb, level, max_piece_secs, pause_ms }
    }

    /// One piece of speech (a WAV file, as `wav_secs` takes) as text.
    pub async fn transcribe(&self, wav: Vec<u8>) -> Result<Transcription, SttError> {
        if !self.installed() {
            return Err(SttError::NotInstalled);
        }
        let secs = wav_secs(&wav).map_err(SttError::BadAudio)?;
        if secs > 180.0 {
            return Err(SttError::BadAudio("pieces are limited to three minutes".into()));
        }
        let _turn = self.turn.lock().await;
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

    fn wav(secs: f64) -> Vec<u8> {
        let data = (secs * 32_000.0) as u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&16_000u32.to_le_bytes());
        b.extend_from_slice(&32_000u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data.to_le_bytes());
        b.resize(b.len() + data as usize, 0);
        b
    }

    #[test]
    fn reads_wav_length() {
        assert_eq!(wav_secs(&wav(2.5)), Ok(2.5));
        assert!(wav_secs(b"RIFF....WAVE").is_err());
        let mut stereo = wav(1.0);
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

    #[tokio::test]
    async fn runs_the_engine() {
        let dir = std::env::temp_dir().join(format!("chm-stt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stt = Stt::new(dir.clone());
        assert!(matches!(stt.transcribe(wav(1.0)).await, Err(SttError::NotInstalled)));

        // A stand-in engine: checks its arguments, reads the audio from stdin, prints text.
        let engine = dir.join(ENGINE);
        std::fs::write(
            &engine,
            "#!/bin/sh\n[ \"$1 $4 $5 $6 $7\" = \"transcribe --input - --threads 4\" ] || { echo bad args >&2; exit 2; }\n\
             n=$(wc -c | tr -d ' ')\necho \"  heard $n bytes\n\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join(MODEL), b"").unwrap();
        let t = stt.transcribe(wav(1.0)).await.unwrap();
        assert_eq!(t.text, format!("heard {} bytes", 44 + 32_000));
        assert!(t.status.installed);

        std::fs::write(&engine, "#!/bin/sh\necho 'model not found' >&2\nexit 1\n").unwrap();
        assert!(matches!(stt.transcribe(wav(1.0)).await, Err(SttError::Failed(why)) if why == "model not found"));
        assert!(matches!(stt.transcribe(b"nope".to_vec()).await, Err(SttError::BadAudio(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
