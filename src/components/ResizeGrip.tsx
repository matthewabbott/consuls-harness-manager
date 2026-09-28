import { useRef, useState } from "react";

import type { CellSize } from "../term/sizing";

interface Props {
  /** Current terminal size in cells. */
  cols: number;
  rows: number;
  cellSize: () => CellSize | null;
  /** Called with the new size when the drag ends. */
  onResize(cols: number, rows: number): void;
}

/**
 * A grip at the terminal's bottom-right corner (rendered inside the terminal's box). Dragging
 * shows a ghost outline with the size it would become; releasing applies it — one resize, not
 * one per pixel.
 */
export default function ResizeGrip({ cols, rows, cellSize, onResize }: Props) {
  const start = useRef<{ x: number; y: number; cell: CellSize } | null>(null);
  const [ghost, setGhost] = useState<{ cols: number; rows: number; w: number; h: number } | null>(null);

  const compute = (dx: number, dy: number, cell: CellSize) => {
    const c = Math.max(20, Math.round(cols + dx / cell.width));
    const r = Math.max(5, Math.round(rows + dy / cell.height));
    return { cols: c, rows: r, w: c * cell.width, h: r * cell.height };
  };

  return (
    <>
      {ghost && (
        <div
          className="pointer-events-none absolute top-0 left-0 z-20 rounded-md border-2 border-dashed border-sky-400/70 bg-sky-400/5"
          style={{ width: ghost.w, height: ghost.h }}
        >
          <span className="absolute right-1 bottom-1 rounded bg-ink-900/90 px-1.5 py-0.5 font-mono text-[11px] text-sky-400">
            {ghost.cols}×{ghost.rows}
          </span>
        </div>
      )}
      <div
        title="Drag to resize the terminal"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          const cell = cellSize();
          if (!cell) return;
          e.preventDefault();
          e.stopPropagation();
          capture(e.target, e.pointerId);
          start.current = { x: e.clientX, y: e.clientY, cell };
          setGhost(compute(0, 0, cell));
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          setGhost(compute(e.clientX - s.x, e.clientY - s.y, s.cell));
        }}
        onPointerUp={(e) => {
          const s = start.current;
          if (!s) return;
          release(e.target, e.pointerId);
          start.current = null;
          const g = compute(e.clientX - s.x, e.clientY - s.y, s.cell);
          setGhost(null);
          if (g.cols !== cols || g.rows !== rows) onResize(g.cols, g.rows);
        }}
        className="absolute -right-3 -bottom-3 z-20 flex h-5 w-5 cursor-nwse-resize items-center justify-center rounded opacity-60 transition-opacity hover:bg-ink-700 hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-mist-400">
          <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
    </>
  );
}

/** Pointer capture keeps the drag alive outside the element; harmless if unavailable. */
function capture(target: EventTarget, id: number) {
  try {
    (target as HTMLElement).setPointerCapture(id);
  } catch {
    /* synthetic or already-released pointer */
  }
}

function release(target: EventTarget, id: number) {
  try {
    (target as HTMLElement).releasePointerCapture(id);
  } catch {
    /* not captured */
  }
}
