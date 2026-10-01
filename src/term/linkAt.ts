// The link under a tapped cell (the phone has no hover or modifier keys): a URL, whole even
// when wrapped across rows, or a file reference on that row.

import { findPaths } from "./links";
import { findUrls, type RowText } from "./urls";

export type TappedLink = { kind: "url"; url: string } | { kind: "path"; path: string; line?: number; col?: number };

/** How many rows either side a wrapped URL may span. */
const URL_ROWS = 20;

type Buffer = { length: number; getLine(y: number): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined };

/** The link at column `x` of buffer row `y` (both 0-based), if any. */
export function linkAt(buffer: Buffer, cols: number, x: number, y: number): TappedLink | null {
  if (y < 0 || y >= buffer.length) return null;
  const first = Math.max(0, y - URL_ROWS);
  const rows: RowText[] = [];
  for (let i = first; i <= Math.min(buffer.length - 1, y + URL_ROWS); i++) {
    const line = buffer.getLine(i);
    rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
  }
  const here = y - first;
  const before = (a: { row: number; col: number }, b: { row: number; col: number }) => a.row < b.row || (a.row === b.row && a.col <= b.col);
  for (const u of findUrls(rows, cols)) {
    if (before(u.start, { row: here, col: x }) && before({ row: here, col: x }, u.end)) return { kind: "url", url: u.url };
  }
  const text = buffer.getLine(y)?.translateToString(true) ?? "";
  for (const r of findPaths(text)) {
    if (x >= r.index && x < r.index + r.length) return { kind: "path", path: r.path, line: r.line, col: r.col };
  }
  return null;
}
