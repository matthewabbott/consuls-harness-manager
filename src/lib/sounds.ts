// The little "hang-up" when dictation stops recording: two falling tones, made here (no file).
// It plays at the phone's media volume, and iOS silences it with the ring/silent switch; the
// app's own switch is in Settings → Dictation.

import { uiStorage } from "./uiState";

const KEY = "consuls.dictation.sound";
let ctx: AudioContext | null = null;

export const hangUpSound = () => uiStorage.getItem(KEY) !== "off";
export const setHangUpSound = (on: boolean) => uiStorage.setItem(KEY, on ? "on" : "off");

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

export function hangUp() {
  if (!ctx || !hangUpSound()) return;
  // A moment after the microphone stops, so iOS has the speaker back (not the earpiece).
  const t = ctx.currentTime + 0.15;
  const tone = (hz: number, at: number, len: number) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.012);
    gain.gain.setValueAtTime(0.18, at + len - 0.05);
    gain.gain.linearRampToValueAtTime(0, at + len);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(at);
    osc.stop(at + len);
  };
  tone(660, t, 0.1);
  tone(495, t + 0.13, 0.16);
}
