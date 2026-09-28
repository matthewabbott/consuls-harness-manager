// Paints a tile snapshot onto a canvas: the whole terminal scaled to the tile's width,
// bottom-aligned when it's taller than the tile (the newest output lives at the bottom).

import type { TileSnapshot } from "../ipc/frames";
import { cssColor, theme } from "./palette";

const FONT = `"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace`;
/** Advance width of a monospace glyph relative to its font size (Cascadia/Consolas ≈ 0.55–0.6). */
const CHAR_ASPECT = 0.58;
const LINE_HEIGHT = 1.22;

export interface TileLayout {
  cellW: number;
  cellH: number;
  fontSize: number;
  offsetY: number;
}

/** Below this the text is just texture; crop the right edge instead of shrinking further. */
const MIN_FONT_PX = 6.5;

export function layoutFor(snap: TileSnapshot, width: number, height: number): TileLayout {
  const fontSize = Math.max((width / Math.max(snap.cols, 1)) / CHAR_ASPECT, MIN_FONT_PX);
  const cellW = fontSize * CHAR_ASPECT;
  const cellH = fontSize * LINE_HEIGHT;
  // Align the last row in use (content or cursor) with the bottom, so a fresh shell whose
  // output is all at the top still shows it.
  let used = snap.altScreen ? snap.rows : snap.cursorY + 1;
  for (let r = snap.lines.length - 1; r >= used; r--) {
    if (snap.lines[r].some((run) => run.text.trim() || run.bg !== 0)) {
      used = r + 1;
      break;
    }
  }
  const total = cellH * Math.min(used, snap.rows);
  return { cellW, cellH, fontSize, offsetY: total > height ? height - total : 0 };
}

export function paintTile(canvas: HTMLCanvasElement, snap: TileSnapshot | undefined, dimmed = false) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, w, h);
  if (!snap) return;

  const { cellW, cellH, fontSize, offsetY } = layoutFor(snap, w, h);
  ctx.textBaseline = "alphabetic";
  const baseline = cellH * 0.78;
  let currentFont = "";
  ctx.globalAlpha = dimmed ? 0.45 : 1;

  for (let r = 0; r < snap.lines.length; r++) {
    const y = offsetY + r * cellH;
    if (y + cellH < 0) continue;
    for (const run of snap.lines[r]) {
      const inverse = (run.attrs & 8) !== 0;
      let fg = cssColor(run.fg) ?? theme.foreground;
      let bg = cssColor(run.bg);
      if (inverse) {
        const tmp = fg;
        fg = bg ?? theme.background;
        bg = tmp;
      }
      const x = run.start * cellW;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, run.cells * cellW + 0.5, cellH + 0.5);
      }
      if ((run.attrs & 64) !== 0 || run.text.trim() === "") continue;
      const font = `${run.attrs & 2 ? "italic " : ""}${run.attrs & 1 ? "600 " : ""}${fontSize.toFixed(2)}px ${FONT}`;
      if (font !== currentFont) {
        ctx.font = font;
        currentFont = font;
      }
      ctx.fillStyle = fg;
      const alpha = (dimmed ? 0.45 : 1) * (run.attrs & 16 ? 0.6 : 1);
      ctx.globalAlpha = alpha;
      // Draw glyph by glyph when the run's natural width drifts from its cell span (wide chars).
      const natural = ctx.measureText(run.text).width;
      const span = run.cells * cellW;
      if (Math.abs(natural - span) > cellW * 0.75) {
        let cx = x;
        for (const ch of run.text) {
          ctx.fillText(ch, cx, y + baseline);
          cx += cellW * (ch.codePointAt(0)! > 0x2e80 ? 2 : 1);
        }
      } else {
        ctx.fillText(run.text, x, y + baseline, span + cellW);
      }
      if (run.attrs & 4) ctx.fillRect(x, y + cellH - Math.max(1, cellH * 0.08), span, Math.max(1, cellH * 0.06));
      ctx.globalAlpha = dimmed ? 0.45 : 1;
    }
  }

  if (snap.cursorVisible && !dimmed) {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = theme.cursor;
    ctx.fillRect(snap.cursorX * cellW, offsetY + snap.cursorY * cellH, Math.max(cellW, 1.5), cellH);
  }
  ctx.globalAlpha = 1;
}
