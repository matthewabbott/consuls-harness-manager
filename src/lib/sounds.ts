// The little "hang-up" when dictation stops recording: two falling tones, made here (no file).
// It plays at the phone's media volume, and iOS silences it with the ring/silent switch; the
// app's own switch and volume are in Settings → Dictation.

import { uiStorage } from "./uiState";

const KEY = "consuls.dictation.sound";
const VOLUME = "consuls.dictation.volume";
let ctx: AudioContext | null = null;

export const hangUpSound = () => uiStorage.getItem(KEY) !== "off";
export const setHangUpSound = (on: boolean) => uiStorage.setItem(KEY, on ? "on" : "off");

/** How loud it is, 0.1–1, under the phone's own volume. */
export function hangUpVolume(): number {
  const v = Number(uiStorage.getItem(VOLUME) ?? NaN);
  return Number.isFinite(v) ? Math.min(1, Math.max(0.1, v)) : 0.7;
}
export const setHangUpVolume = (v: number) => uiStorage.setItem(VOLUME, String(v));

/** In the tap that starts recording: iOS only lets audio start in one, and it may end without one. */
export function primeSounds() {
  if (!hangUpSound()) return;
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function hangUp(delay = 0.15) {
  if (!ctx || !hangUpSound()) return;
  // A moment after the microphone stops, so iOS has the speaker back (not the earpiece).
  const t = ctx.currentTime + delay;
  // Loudness goes roughly with the square of the amplitude; at most 0.75 (the tones don't overlap).
  const peak = 0.75 * hangUpVolume() ** 2;
  const tone = (hz: number, at: number, len: number) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.012);
    gain.gain.setValueAtTime(peak, at + len - 0.05);
    gain.gain.linearRampToValueAtTime(0, at + len);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(at);
    osc.stop(at + len);
  };
  tone(660, t, 0.1);
  tone(495, t + 0.13, 0.16);
}

/** Plays it now, as set (in the tap or the slider's release that asks for it). */
export function previewHangUp() {
  primeSounds();
  hangUp(0.02);
}
