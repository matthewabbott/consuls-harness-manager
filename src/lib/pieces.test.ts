import { describe, expect, it } from "vitest";

import type { SttStatus } from "../ipc/bindings/SttStatus";
import { type Ask, PieceSender, RATE, Resampler, Segmenter, pcm16 } from "./pieces";

/** Speech-like sound (a buzz that wavers in loudness) or quiet room noise, `secs` long. */
function sound(secs: number, speech: boolean): Float32Array {
  const out = new Float32Array(Math.round(secs * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = speech ? 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) * Math.sin(2 * Math.PI * 180 * t) : 0.002 * (Math.random() - 0.5);
  }
  return out;
}

function pieces(parts: [number, boolean][], policy = { maxSecs: 30, pauseMs: 700 }): number[] {
  const got: number[] = [];
  const s = new Segmenter(policy, (p) => got.push(p.length / RATE));
  for (const [secs, speech] of parts) s.push(sound(secs, speech));
  s.flush();
  return got;
}

describe("Segmenter", () => {
  it("cuts at a pause, keeping the pause at the end of the piece", () => {
    const got = pieces([
      [5, true],
      [1.2, false],
      [5, true],
    ]);
    expect(got).toHaveLength(2);
    expect(got[0]).toBeCloseTo(5.7, 1);
    expect(got[1]).toBeGreaterThan(4.9);
  });

  it("doesn't cut at a pause shorter than the policy's, or in a piece's first seconds", () => {
    expect(pieces([[5, true], [0.4, false], [5, true]])).toHaveLength(1);
    expect(pieces([[5, true], [0.4, false], [5, true]], { maxSecs: 8, pauseMs: 250 })).toHaveLength(2);
    expect(pieces([[1, true], [1, false], [5, true]])).toHaveLength(1);
  });

  it("cuts a long stretch without pauses at its longest, in a quiet moment", () => {
    // 40 s of speech with a 100 ms dip every 3 s: too short to count as pauses.
    const parts: [number, boolean][] = [];
    for (let i = 0; i < 13; i++) parts.push([2.9, true], [0.1, false]);
    const got = pieces(parts);
    expect(got).toHaveLength(2);
    expect(got[0]).toBeLessThanOrEqual(30);
    expect(got[0]).toBeGreaterThan(27.4);
    // It ends in a dip: the 100 ms around 29.9 s (3 s cycles, dip at the end of each).
    expect((got[0] + 0.1) % 3).toBeLessThan(0.15);
  });

  it("sends nothing for silence, however long", () => {
    expect(pieces([[60, false]])).toEqual([]);
    // What's kept: 0.3 s before the speech, the speech, and the pause that ended it.
    expect(pieces([[10, false], [3, true], [10, false]])).toEqual([expect.closeTo(4, 1)]);
  });
});

describe("Resampler", () => {
  it("turns 48 kHz into 16 kHz across chunks, keeping the level", () => {
    const r = new Resampler(48_000);
    const a = r.push(new Float32Array(1000).fill(0.5));
    const b = r.push(new Float32Array(2000).fill(0.5));
    expect(a.length + b.length).toBe(1000);
    expect(b.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it("copes with a rate that doesn't divide evenly", () => {
    const r = new Resampler(44_100);
    expect(r.push(new Float32Array(44_100)).length).toBe(16_000);
  });
});

describe("pcm16", () => {
  it("writes 16-bit little-endian samples", async () => {
    const b = new DataView(await pcm16(Float32Array.from([0, 1, -1, 2])).arrayBuffer());
    expect([b.getInt16(0, true), b.getInt16(2, true), b.getInt16(4, true), b.getInt16(6, true)]).toEqual([0, 32767, -32768, 32767]);
  });
});

const status: SttStatus = { installed: true, availableMb: 8000, level: "green", maxPieceSecs: 30, pauseMs: 700 };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A pretend server: keeps each piece's samples, answers drafts and ends; `fail` breaks one ask. */
function server(fail?: { ask: Ask; error: Error | string; once?: boolean }) {
  const pieces = new Map<string, number>();
  const calls: { piece: string; at: number; n: number; ask: Ask }[] = [];
  const send = async (piece: string, at: number, pcm: Blob, ask: Ask) => {
    const n = pcm.size / 2;
    calls.push({ piece, at, n, ask });
    if (fail && fail.ask === ask) {
      const e = fail.error;
      if (fail.once) fail = undefined;
      throw e;
    }
    if (at > (pieces.get(piece) ?? 0)) throw Object.assign(new Error("gap"), { name: "SttGap" });
    pieces.set(piece, at + n);
    if (!ask) return null;
    const secs = ((at + n) / RATE).toFixed(1);
    return { text: ask === "end" ? `Piece of ${secs} s.` : `draft of ${secs}`, status };
  };
  return { calls, send };
}

/** Feeds `parts` in 100 ms blocks, letting requests finish between them; then stops. */
async function dictate(parts: [number, boolean][], send: ReturnType<typeof server>["send"], drafts = true) {
  const texts: [string, number][] = [];
  const events: string[] = [];
  const s = new PieceSender({ maxSecs: 30, pauseMs: 700, drafts }, send, {
    onText: (t, f) => texts.push([t, f]),
    onStatus: () => {},
    onError: (e) => events.push(`error: ${e}`),
    onDone: () => events.push("done"),
  });
  for (const [secs, speech] of parts) {
    const audio = sound(secs, speech);
    for (let i = 0; i < audio.length; i += RATE / 10) {
      s.push(audio.subarray(i, i + RATE / 10));
      await tick();
    }
  }
  s.stop();
  for (let i = 0; i < 20; i++) await tick();
  return { texts, events, last: texts.at(-1) };
}

describe("PieceSender", () => {
  it("streams a piece while it's spoken, with drafts, then its final text", async () => {
    const srv = server();
    const { texts, events, last } = await dictate([[5, true], [1.2, false], [3, true]], srv.send);
    const first = srv.calls.filter((c) => c.piece.endsWith("-0"));
    // The audio goes in order, each part from where the last one ended.
    for (let i = 1; i < first.length; i++) expect(first[i].at).toBeLessThanOrEqual(first[i - 1].at + first[i - 1].n);
    expect(first.filter((c) => c.ask === "draft").length).toBeGreaterThan(3);
    expect(first.at(-1)!.ask).toBe("end");
    // The final part is small: the rest of the piece after what was streamed.
    expect(first.at(-1)!.n).toBeLessThan(RATE);
    // Drafts showed while talking, as tentative text.
    expect(texts.some(([t, f]) => t.startsWith("draft of") && f === 0)).toBe(true);
    // The second piece keeps 0.3 s from before the speech.
    expect(last).toEqual(["Piece of 5.7 s. Piece of 3.3 s.", 31]);
    expect(events).toEqual(["done"]);
  });

  it("without drafts, sends the audio a couple of seconds at a time", async () => {
    const srv = server();
    const { last } = await dictate([[5, true], [1, false]], srv.send, false);
    expect(srv.calls.map((c) => c.ask)).toEqual([null, null, "end"]);
    expect(last![0]).toMatch(/^Piece of 5\.\d s\.$/);
  });

  it("sends a piece whole when the server lost its audio", async () => {
    const srv = server({ ask: "end", error: Object.assign(new Error("gap"), { name: "SttGap" }), once: true });
    const { last, events } = await dictate([[3, true], [1, false]], srv.send);
    const ends = srv.calls.filter((c) => c.ask === "end");
    expect(ends.map((c) => c.at)).toEqual([expect.any(Number), 0]);
    expect(ends[1].n).toBeGreaterThan(3 * RATE);
    expect(last![0]).toMatch(/^Piece of/);
    expect(events).toEqual(["done"]);
  });

  it("stops at a piece that fails, keeping the drafts as text", async () => {
    const srv = server({ ask: "end", error: "no memory" });
    const { last, events } = await dictate([[3, true], [1, false]], srv.send);
    expect(events).toEqual(["error: no memory", "done"]);
    expect(last![0]).toMatch(/^draft of \d/);
  });
});
