// Cutting dictation into pieces for the server's speech engine: at your pauses, and never longer
// than the server's memory allows (it reports the longest piece and the pause that ends one).
// Recording never stops for a cut; pieces only decide where the audio is split for transcribing.
// Each piece's audio streams to the server while you talk (`PieceSender`), which sends back a
// draft of it about once a second when it has memory to spare, and its final text once it ends.

import type { SttStatus } from "../ipc/bindings/SttStatus";
import type { Transcription } from "../ipc/bindings/Transcription";
import { join } from "./speech";

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
  /** Ask for drafts while a piece is being spoken. */
  drafts?: boolean;
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
    /** A piece was cut with too little speech in it, and dropped. */
    private onDrop: () => void = () => {},
  ) {}

  setPolicy(p: PiecePolicy) {
    this.policy = p;
  }

  /** Whether the piece in progress has enough speech to be sent (from then on it only grows). */
  speaking(): boolean {
    return this.voiced >= MIN_VOICED;
  }

  /** The piece in progress so far, in samples. */
  length(): number {
    return this.frames.length * FRAME;
  }

  /** The piece in progress from sample `from` (a multiple of 320) on. */
  audio(from = 0): Float32Array {
    const frames = this.frames.slice(Math.floor(from / FRAME));
    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => out.set(f, i * FRAME));
    return out;
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
    if (voiced < MIN_VOICED) return this.onDrop();
    const out = new Float32Array(piece.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of piece) {
      out.set(f, o);
      o += f.length;
    }
    this.onPiece(out);
  }
}

/** Samples as 16-bit PCM (little-endian), as the server takes them. */
export function pcm16(samples: Float32Array): Blob {
  const b = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([b.buffer], { type: "application/octet-stream" });
}

/** What a piece's audio is sent for: a draft of it so far, its final text, or nothing yet. */
export type Ask = "draft" | "end" | null;

/**
 * Sends audio of `piece` from sample `at` to the server, with text back when asked for (null:
 * none asked for, or a draft it skipped). Rejects with an error named "SttGap" when the server
 * doesn't have the piece up to `at`.
 */
export type Send = (piece: string, at: number, pcm: Blob, ask: Ask) => Promise<Transcription | null>;

export interface SenderEvents {
  /** All the text so far: its first `final` characters are final, the rest drafts (and "…"). */
  onText(text: string, final: number): void;
  onStatus(s: SttStatus): void;
  /** A piece's text couldn't be had: sending stops (`onDone` follows). */
  onError(e: unknown): void;
  /** Stopped, and every piece is back. */
  onDone(): void;
}

/** A draft is asked for after this much more audio; without drafts, audio goes in this much at a time. */
const DRAFT_EVERY = 0.8 * RATE;
const SEND_EVERY = 2 * RATE;
/** After audio didn't get there, before trying again. */
const REST_MS = 1000;

interface Piece {
  id: string;
  /** Audio the server has (samples). */
  sent: number;
  /** Where the last draft was asked for. */
  drafted: number;
  draft: string;
  /** Its audio, once it's been cut. */
  audio?: Float32Array;
}

/**
 * Audio in (`push`), text out: cuts the audio into pieces (`Segmenter`) and streams each to the
 * server, one request at a time, in order: a cut piece's final text first, then more of the piece
 * being spoken (with a draft asked for when the policy says so).
 */
export class PieceSender {
  private segmenter: Segmenter;
  private session = Math.random().toString(36).slice(2, 10);
  private count = 0;
  private cur: Piece;
  private cut: Piece[] = [];
  private text = "";
  private busy = false;
  private resting = false;
  private stopped = false;
  private over = false;

  constructor(
    private policy: PiecePolicy,
    private send: Send,
    private o: SenderEvents,
  ) {
    this.cur = this.piece();
    this.segmenter = new Segmenter(
      policy,
      (audio) => {
        this.cur.audio = audio;
        this.cut.push(this.cur);
        this.cur = this.piece();
      },
      () => {
        this.cur = this.piece();
        this.show();
      },
    );
  }

  setPolicy(p: PiecePolicy) {
    this.policy = p;
    this.segmenter.setPolicy(p);
  }

  push(samples: Float32Array) {
    if (this.stopped) return;
    this.segmenter.push(samples);
    this.pump();
  }

  /** No more audio: the rest is the last piece. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.segmenter.flush();
    this.show();
    this.pump();
  }

  /** Stops at once, without another word. */
  abort() {
    this.stopped = this.over = true;
  }

  private piece(): Piece {
    return { id: `${this.session}-${this.count++}`, sent: 0, drafted: 0, draft: "" };
  }

  private show(done = false) {
    let t = [...this.cut, this.cur].reduce((t, p) => (p.draft ? join(t, p.draft) : t), this.text);
    if (!done && this.cut.length) t = t ? `${t} …` : "…";
    this.o.onText(t, this.text.length);
  }

  private pump() {
    if (this.busy || this.over) return;
    const job = this.next();
    if (!job) {
      if (this.stopped && !this.cut.length) {
        this.over = true;
        this.o.onDone();
      }
      return;
    }
    this.busy = true;
    void job.then(() => {
      this.busy = false;
      this.pump();
    });
  }

  private next(): Promise<void> | null {
    if (this.cut.length) return this.finish(this.cut[0]);
    if (this.stopped || this.resting || !this.segmenter.speaking()) return null;
    const p = this.cur;
    const have = this.segmenter.length();
    const draft = !!this.policy.drafts && have - p.drafted >= DRAFT_EVERY;
    if (!draft && have - p.sent < SEND_EVERY) return null;
    return this.upload(p, draft);
  }

  private async upload(p: Piece, draft: boolean) {
    const at = p.sent;
    const audio = this.segmenter.audio(at);
    try {
      const t = await this.send(p.id, at, pcm16(audio), draft ? "draft" : null);
      p.sent = at + audio.length;
      if (draft) p.drafted = p.sent;
      if (t && !this.over) {
        this.o.onStatus(t.status);
        p.draft = t.text;
        this.show();
      }
    } catch (e) {
      // The next upload, or the piece's final one, carries this audio again.
      if ((e as Error)?.name === "SttGap") p.sent = 0;
      this.resting = true;
      setTimeout(() => {
        this.resting = false;
        this.pump();
      }, REST_MS);
    }
  }

  private async finish(p: Piece) {
    const audio = p.audio!;
    const at = Math.min(p.sent, audio.length);
    let t: Transcription | null;
    try {
      t = await this.send(p.id, at, pcm16(audio.subarray(at)), "end").catch((e) => {
        if ((e as Error)?.name !== "SttGap") throw e;
        return this.send(p.id, 0, pcm16(audio), "end");
      });
    } catch (e) {
      if (this.over) return;
      this.show(true);
      this.over = true;
      this.o.onError(e);
      this.o.onDone();
      return;
    }
    if (this.over) return;
    this.cut.shift();
    if (t) {
      this.o.onStatus(t.status);
      this.text = join(this.text, t.text);
    }
    this.show();
  }
}
