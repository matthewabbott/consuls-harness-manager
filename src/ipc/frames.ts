// Binary frames from the core: `kind u8, key u32 LE, len u32 LE, payload`, concatenated.

export const FRAME_TILE = 1;
export const FRAME_RAW = 2;
export const FRAME_RESET = 3;

export interface Frame {
  kind: number;
  key: number;
  payload: Uint8Array;
}

export function* parseFrames(buf: Uint8Array): Generator<Frame> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos + 9 <= buf.length) {
    const kind = view.getUint8(pos);
    const key = view.getUint32(pos + 1, true);
    const len = view.getUint32(pos + 5, true);
    const start = pos + 9;
    if (start + len > buf.length) return; // truncated; shouldn't happen
    yield { kind, key, payload: buf.subarray(start, start + len) };
    pos = start + len;
  }
}

export interface TileRun {
  start: number;
  cells: number;
  /** 0 = default; 0x01_0000NN = palette NN; 0x02_RRGGBB = true colour. */
  fg: number;
  bg: number;
  /** bold 1, italic 2, underline 4, inverse 8, dim 16, strike 32, hidden 64 */
  attrs: number;
  text: string;
}

export interface TileSnapshot {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  altScreen: boolean;
  lines: TileRun[][];
}

const utf8 = new TextDecoder();
const utf8Enc = new TextEncoder();

export function decodeTile(p: Uint8Array): TileSnapshot {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const cols = v.getUint16(0, true);
  const rows = v.getUint16(2, true);
  const cursorX = v.getUint16(4, true);
  const cursorY = v.getUint16(6, true);
  const flags = v.getUint8(8);
  let pos = 9;
  const lines: TileRun[][] = [];
  for (let r = 0; r < rows && pos + 2 <= p.length; r++) {
    const count = v.getUint16(pos, true);
    pos += 2;
    const runs: TileRun[] = [];
    for (let i = 0; i < count; i++) {
      const start = v.getUint16(pos, true);
      const cells = v.getUint16(pos + 2, true);
      const fg = v.getUint32(pos + 4, true);
      const bg = v.getUint32(pos + 8, true);
      const attrs = v.getUint16(pos + 12, true);
      const len = v.getUint16(pos + 14, true);
      const text = utf8.decode(p.subarray(pos + 16, pos + 16 + len));
      pos += 16 + len;
      runs.push({ start, cells, fg, bg, attrs, text });
    }
    lines.push(runs);
  }
  return { cols, rows, cursorX, cursorY, cursorVisible: (flags & 1) !== 0, altScreen: (flags & 2) !== 0, lines };
}

/** Inverse of `decodeTile` (used by the mock backend and tests). */
export function encodeTile(s: TileSnapshot): Uint8Array {
  const parts: number[] = [];
  const u16 = (n: number) => parts.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n: number) => parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  u16(s.cols);
  u16(s.rows);
  u16(s.cursorX);
  u16(s.cursorY);
  parts.push((s.cursorVisible ? 1 : 0) | (s.altScreen ? 2 : 0));
  for (let r = 0; r < s.rows; r++) {
    const runs = s.lines[r] ?? [];
    u16(runs.length);
    for (const run of runs) {
      const bytes = utf8Enc.encode(run.text);
      u16(run.start);
      u16(run.cells);
      u32(run.fg);
      u32(run.bg);
      u16(run.attrs);
      u16(bytes.length);
      for (const b of bytes) parts.push(b);
    }
  }
  return Uint8Array.from(parts);
}

export function encodeFrame(kind: number, key: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, kind);
  v.setUint32(1, key, true);
  v.setUint32(5, payload.length, true);
  out.set(payload, 9);
  return out;
}
