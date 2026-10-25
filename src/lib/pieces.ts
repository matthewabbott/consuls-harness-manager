// Cutting dictation into pieces for the server's speech engine: at your pauses, and never longer
// than the server's memory allows (it reports the longest piece and the pause that ends one).
// Recording never stops for a cut; pieces only decide where the audio is split for transcribing.

export const RATE = 16_000;
const FRAME = 320; // 20 ms
const FRAME_MS = 20;
/** What's kept before speech starts (silence otherwise isn't kept). */
const LEAD = 15;
/** A piece needs this much speech to be sent (shorter: a cough, a click). */
const MIN_VOICED = 8;
/** At the longest, the cut goes at the quietest 100 ms of the last 2.5 s. */
const LOOKBACK = 125;
const WINDOW = 5;

export interface PiecePolicy {
  maxSecs: number;
  pauseMs: number;
}

/** Audio at `from` Hz to 16 kHz: each output sample is the mean of the input it spans. */
export class Resampler {
  private step: number;
  private edge: number;
  private t = 0;
  private sum = 0;
  private n = 0;

  constructor(from: number) {
    this.step = from / RATE;
    this.edge = this.step;
  }

  push(x: Float32Array): Float32Array {
    if (this.step === 1) return x;
    const out: number[] = [];
    for (let i = 0; i < x.length; i++) {
      this.sum += x[i];
      this.n++;
      if (++this.t >= this.edge) {
        out.push(this.sum / this.n);
        this.sum = 0;
        this.n = 0;
        this.edge += this.step;
      }
    }
    return Float32Array.from(out);
  }
}

const level = (f: Float32Array) => {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return 10 * Math.log10(s / f.length + 1e-12); // dBFS
};

/**
 * 16 kHz audio in, pieces out (`onPiece`). A piece ends at a pause (once it's at least a few
 * seconds long), or at the longest the policy allows, at its quietest moment near the end.
 * Pieces with next to no speech in them are dropped.
 */
export class Segmenter {
  private frames: Float32Array[] = [];
  private voice: boolean[] = [];
  private voiced = 0;
  private silent = 0;
  private floor = -60;
  private partial = new Float32Array(FRAME);
  private filled = 0;

  constructor(
    private policy: PiecePolicy,
    private onPiece: (samples: Float32Array) => void,
  ) {}

  setPolicy(p: PiecePolicy) {
    this.policy = p;
  }

  push(x: Float32Array) {
    let i = 0;
    while (i < x.length) {
      const n = Math.min(FRAME - this.filled, x.length - i);
      this.partial.set(x.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === FRAME) {
        this.frame(this.partial);
        this.partial = new Float32Array(FRAME);
        this.filled = 0;
      }
    }
  }

  /** The rest, as the last piece (if it has speech). */
  flush() {
    if (this.filled) this.frame(this.partial.slice(0, this.filled));
    this.filled = 0;
    this.cut(this.frames.length);
  }

  private frame(f: Float32Array) {
    const db = level(f);
    // The background's level: follows quiet frames down at once, drifts up 1 dB/s through
    // lasting noise (which then stops counting as speech).
    this.floor = db < this.floor ? db : this.floor + 0.02;
    const speech = db > Math.max(this.floor + 10, -50);
    this.frames.push(f);
    this.voice.push(speech);
    if (speech) {
      this.voiced++;
      this.silent = 0;
    } else this.silent++;
    if (this.voiced === 0 && this.frames.length > LEAD) {
      this.frames.shift();
      this.voice.shift();
      return;
    }
    const secs = this.frames.length * (FRAME_MS / 1000);
    const minSecs = Math.min(2.5, this.policy.maxSecs / 2);
    if (this.voiced >= MIN_VOICED && secs >= minSecs && this.silent * FRAME_MS >= this.policy.pauseMs) this.cut(this.frames.length);
    else if (secs >= this.policy.maxSecs) this.cut(this.quietest());
  }

  /** Where to cut a piece that's run to the longest: the middle of its quietest 100 ms lately. */
  private quietest(): number {
    const end = this.frames.length;
    const start = Math.max(WINDOW, end - LOOKBACK);
    let best = end;
    let bestDb = Infinity;
    for (let i = start; i <= end - WINDOW; i++) {
      let db = 0;
      for (let j = i; j < i + WINDOW; j++) db += level(this.frames[j]);
      if (db < bestDb) {
        bestDb = db;
        best = i + Math.floor(WINDOW / 2);
      }
    }
    return best;
  }

  private cut(at: number) {
    const piece = this.frames.slice(0, at);
    const voiced = this.voice.slice(0, at).filter(Boolean).length;
    this.frames = this.frames.slice(at);
    this.voice = this.voice.slice(at);
    this.voiced = this.voice.filter(Boolean).length;
    this.silent = this.voice.length - (this.voice.lastIndexOf(true) + 1);
    if (voiced < MIN_VOICED) return;
    const out = new Float32Array(piece.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of piece) {
      out.set(f, o);
      o += f.length;
    }
    this.onPiece(out);
  }
}

/** 16 kHz mono 16-bit PCM in a WAV file, as the server takes it. */
export function wav(samples: Float32Array): Blob {
  const b = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  b.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); // PCM
  b.setUint16(22, 1, true); // mono
  b.setUint32(24, RATE, true);
  b.setUint32(28, RATE * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  text(36, "data");
  b.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([b.buffer], { type: "audio/wav" });
}
