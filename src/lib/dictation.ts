// Dictation on the Consuls server (Fluid Speech Mini, crates/chm-daemon/src/stt.rs): the phone
// records, cuts what you say into pieces at your pauses (`pieces.ts`, as long as the server's
// memory allows) and streams them to the server: a draft of what you're saying shows about once a
// second (with memory to spare, and "Live text" on), and each piece's final text replaces its
// draft when it ends. Where the server can't (not installed, out of memory, the switch in
// Settings off), the browser's own recognizer (`speech.ts`) does it.

import { create } from "zustand";

import { backend } from "../ipc/backend";
import type { SttStatus } from "../ipc/bindings/SttStatus";
import { type PiecePolicy, PieceSender } from "./pieces";
import { capture, type Capture } from "./recorder";
import type { Dictation, DictationEvents } from "./speech";
import { uiStorage } from "./uiState";

const KEY = "consuls.dictation.server";
export const onServerPref = () => uiStorage.getItem(KEY) !== "off";
export const setOnServerPref = (on: boolean) => uiStorage.setItem(KEY, on ? "on" : "off");
const LIVE = "consuls.dictation.live";
export const livePref = () => uiStorage.getItem(LIVE) !== "off";
export const setLivePref = (on: boolean) => uiStorage.setItem(LIVE, on ? "on" : "off");

interface SttState {
  /** The server's dictation, as last heard: null until known, or where there's none. */
  status: SttStatus | null;
  refresh(): void;
  set(s: SttStatus): void;
}

export const useStt = create<SttState>((set) => ({
  status: null,
  refresh: () =>
    void backend()
      .then((b) => b.sttStatus())
      .then((status) => set({ status }))
      .catch(() => undefined),
  set: (status) => set({ status }),
}));

/** Whether a dictation started now would go to the server. */
export function serverReady(s: SttStatus | null): boolean {
  return !!s && s.installed && s.level !== "out" && onServerPref();
}

const policyOf = (s: SttStatus): PiecePolicy => ({
  maxSecs: s.maxPieceSecs || 8,
  pauseMs: s.pauseMs || 250,
  drafts: s.level === "green" && livePref(),
});

function micError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError") return "The microphone isn't allowed: check it in Settings → Apps → Safari.";
  if (name === "NotFoundError") return "No microphone was found.";
  return `The microphone couldn't start: ${e}`;
}

/**
 * Records with `ctx` (made in the tap that started it) until stopped; also stops by itself when
 * the app goes to the background, the microphone goes away, or a piece fails.
 */
export function dictateOnServer(ctx: AudioContext, status: SttStatus, o: DictationEvents): Dictation {
  let stopped = false;
  let mic: Capture | null = null;

  const sender = new PieceSender(
    policyOf(status),
    async (piece, at, pcm, ask) => (await backend()).sttSend(piece, at, pcm, ask),
    {
      onText: o.onText,
      onStatus: (s) => {
        useStt.getState().set(s);
        sender.setPolicy(policyOf(s));
      },
      onError: (e) => {
        o.onError(`Dictation stopped: ${e}`);
        useStt.getState().refresh();
        stop();
      },
      onDone: o.onEnd,
    },
  );

  const hidden = () => {
    if (document.visibilityState === "hidden") stop();
  };
  const release = () => {
    document.removeEventListener("visibilitychange", hidden);
    mic?.stop();
    mic = null;
    void ctx.close().catch(() => undefined);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    release();
    o.onStopped();
    sender.stop();
  };

  document.addEventListener("visibilitychange", hidden);
  capture(ctx, (samples) => sender.push(samples), stop).then(
    (c) => {
      if (stopped) c.stop();
      else mic = c;
    },
    (e) => {
      if (stopped) return;
      o.onError(micError(e));
      stop();
    },
  );

  return {
    stop,
    abort: () => {
      stopped = true;
      sender.abort();
      release();
    },
  };
}
