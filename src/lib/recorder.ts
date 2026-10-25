// The microphone, as 16 kHz samples, for dictation on the server.

import { Resampler } from "./pieces";

export interface Capture {
  stop(): void;
}

/**
 * An audio context for recording, made in the tap that starts it (iOS only lets audio start in
 * one). At 16 kHz where the browser resamples for us.
 */
export function captureContext(): AudioContext {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16_000 });
  } catch {
    ctx = new AudioContext();
  }
  void ctx.resume();
  return ctx;
}

/** Records into `onAudio` until stopped; `onEnd` if the microphone goes away (a call, another app). */
export async function capture(ctx: AudioContext, onAudio: (samples: Float32Array) => void, onEnd: () => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const resample = new Resampler(ctx.sampleRate);
  const source = ctx.createMediaStreamSource(stream);
  // Pulled through a silent output: some browsers only run nodes that lead to the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  let node: AudioNode;
  try {
    await ctx.audioWorklet.addModule(new URL("./captureWorklet.js", import.meta.url));
    const w = new AudioWorkletNode(ctx, "consuls-capture");
    w.port.onmessage = (e: MessageEvent<Float32Array>) => onAudio(resample.push(e.data));
    node = w;
  } catch {
    const p = ctx.createScriptProcessor(4096, 1, 1);
    p.onaudioprocess = (e) => onAudio(resample.push(new Float32Array(e.inputBuffer.getChannelData(0))));
    node = p;
  }
  source.connect(node);
  node.connect(mute);
  const track = stream.getAudioTracks()[0];
  if (track) track.onended = onEnd;
  return {
    stop() {
      if (track) track.onended = null;
      stream.getTracks().forEach((t) => t.stop());
      source.disconnect();
      node.disconnect();
    },
  };
}
