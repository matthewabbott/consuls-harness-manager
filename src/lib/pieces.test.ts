import { describe, expect, it } from "vitest";

import { RATE, Resampler, Segmenter, wav } from "./pieces";

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

describe("wav", () => {
  it("writes a 16 kHz mono 16-bit file", async () => {
    const b = new DataView(await wav(Float32Array.from([0, 1, -1, 2])).arrayBuffer());
    expect(b.byteLength).toBe(44 + 8);
    expect([b.getUint16(22, true), b.getUint32(24, true), b.getUint16(34, true)]).toEqual([1, 16_000, 16]);
    expect([b.getInt16(44, true), b.getInt16(46, true), b.getInt16(48, true), b.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  });
});
