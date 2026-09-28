import { describe, expect, it } from "vitest";
import { FRAME_TILE, decodeTile, encodeFrame, encodeTile, parseFrames, type TileSnapshot } from "./frames";

const snap: TileSnapshot = {
  cols: 12,
  rows: 2,
  cursorX: 3,
  cursorY: 1,
  cursorVisible: true,
  altScreen: false,
  lines: [
    [
      { start: 0, cells: 3, fg: 0, bg: 0, attrs: 0, text: "hi " },
      { start: 3, cells: 4, fg: 0x0100_0001, bg: 0x0212_3456, attrs: 1, text: "red✳" },
    ],
    [{ start: 2, cells: 4, fg: 0, bg: 0, attrs: 8, text: "日本" }],
  ],
};

describe("frames", () => {
  it("round-trips tile snapshots", () => {
    expect(decodeTile(encodeTile(snap))).toEqual(snap);
  });

  it("splits concatenated frames", () => {
    const a = encodeFrame(FRAME_TILE, 7, encodeTile(snap));
    const b = encodeFrame(2, 0x01020304, new Uint8Array([1, 2, 3]));
    const buf = new Uint8Array(a.length + b.length);
    buf.set(a);
    buf.set(b, a.length);
    const frames = [...parseFrames(buf)];
    expect(frames.map((f) => [f.kind, f.key, f.payload.length])).toEqual([
      [1, 7, a.length - 9],
      [2, 0x01020304, 3],
    ]);
  });

  it("matches the Rust frame layout", () => {
    // Same bytes as chm-core's frames::tests::layout.
    expect([...encodeFrame(2, 0x01020304, new TextEncoder().encode("hi"))]).toEqual([2, 4, 3, 2, 1, 2, 0, 0, 0, 104, 105]);
  });
});
