// "Smart copy": turn a terminal selection back into the text the agent meant.
//
// Terminals and agent TUIs break long lines in two ways: the terminal soft-wraps
// (xterm marks those rows `isWrapped`), and TUIs like Claude Code / Codex hard-wrap their
// own output to the pane width, indenting continuation lines under a gutter (`⏺ `, `• `).
// Copying raw gives you those breaks and gutters. This joins soft wraps always, joins
// hard wraps when a row ran up to the right edge and the next row continues the same
// block, strips the gutter markers, and dedents. A URL wrapped that way is joined without a
// space, so it copies whole.

import { EDGE_SLACK, continuesUrl } from "./urls";

export interface Row {
  text: string;
  /** The terminal soft-wrapped this row onto the previous one. */
  wrapped: boolean;
}

const GUTTER = /^(\s*)([⏺●•⎿∙▪◦·]|└|⏵⏵?)\s+/u;
const LIST_ITEM = /^\s*([-*+]|\d+[.)]|[a-z][.)])\s+/i;
const FENCE = /^\s*(```|~~~)/;

function indentOf(s: string): number {
  return s.length - s.trimStart().length;
}

export function smartCopy(rows: Row[], cols: number): string {
  // 1. Undo terminal soft wraps.
  const lines: string[] = [];
  for (const r of rows) {
    if (r.wrapped && lines.length) lines[lines.length - 1] += r.text;
    else lines.push(r.text);
  }

  // 2. Strip gutters (and the matching indent of their continuation lines) and undo the
  //    TUI's hard wraps inside paragraphs.
  const out: string[] = [];
  let gutterCol = 0;
  let inFence = false;
  let prev: { raw: string; line: string } | null = null;
  for (const full of lines) {
    const raw = full.replace(/\s+$/u, "");
    const blank = raw.trim() === "";
    const gutter = GUTTER.exec(raw);
    let line = raw;
    if (gutter) {
      gutterCol = gutter[0].length;
      line = raw.slice(gutter[0].length);
    } else if (!blank) {
      if (indentOf(raw) >= gutterCol) line = raw.slice(gutterCol);
      else gutterCol = 0;
    }
    const fence = FENCE.test(line);

    const joinable: boolean =
      prev !== null &&
      !inFence &&
      !fence &&
      !gutter &&
      !blank &&
      prev.line.trim() !== "" &&
      prev.raw.length >= cols - EDGE_SLACK &&
      !LIST_ITEM.test(line) &&
      Math.abs(indentOf(line) - indentOf(prev.line.replace(LIST_ITEM, (m) => " ".repeat(m.length)))) <= 2;

    if (joinable) {
      const last = out.length - 1;
      const glue = continuesUrl(prev!.raw, out[last], line, cols) || out[last].endsWith("-") ? "" : " ";
      out[last] += glue + line.trimStart();
    } else {
      out.push(line);
    }
    if (fence) inFence = !inFence;
    prev = { raw, line: joinable ? out[out.length - 1] : line };
  }

  // 3. Dedent by the smallest common indentation.
  const nonEmpty = out.filter((l) => l.trim() !== "");
  const common = nonEmpty.length ? Math.min(...nonEmpty.map(indentOf)) : 0;
  return out
    .map((l) => l.slice(Math.min(common, indentOf(l))))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Plain copy: rows joined only where the terminal soft-wrapped them. */
export function rawCopy(rows: Row[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.wrapped && lines.length) lines[lines.length - 1] += r.text;
    else lines.push(r.text);
  }
  return lines.map((l) => l.replace(/\s+$/u, "")).join("\n");
}

/** Reads the current xterm selection as rows (with soft-wrap flags). */
export function selectionRows(term: {
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  buffer: { active: { getLine(y: number): { isWrapped: boolean; translateToString(trim?: boolean, start?: number, end?: number): string } | undefined } };
}): Row[] {
  const pos = term.getSelectionPosition();
  if (!pos) return [];
  const rows: Row[] = [];
  for (let y = pos.start.y; y <= pos.end.y; y++) {
    const line = term.buffer.active.getLine(y);
    if (!line) continue;
    const start = y === pos.start.y ? pos.start.x : 0;
    const end = y === pos.end.y ? pos.end.x : undefined;
    rows.push({ text: line.translateToString(false, start, end), wrapped: y !== pos.start.y && line.isWrapped });
  }
  return rows;
}
