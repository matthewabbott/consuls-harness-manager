// Pointer-based dragging of tiles onto sidebar labels. (HTML5 drag-and-drop is swallowed by
// the WebView's native file-drop handling on Windows, so we track pointers ourselves.)

import { create } from "zustand";

interface DragState {
  /** Pane key being dragged (after the pointer moved far enough to count as a drag). */
  key: number | null;
  title: string;
  x: number;
  y: number;
  /** Label id under the pointer, if any (drop targets carry `data-label-drop`). */
  over: string | null;
}

export const useDrag = create<DragState>(() => ({
  key: null,
  title: "",
  x: 0,
  y: 0,
  over: null,
}));

const THRESHOLD = 6;
let justDragged = false;

/** True right after a drag ended — tiles use it to ignore the click that follows. */
export function consumeJustDragged(): boolean {
  const v = justDragged;
  justDragged = false;
  return v;
}

/**
 * Starts tracking a potential drag of pane `key`. `onDrop(labelId)` runs if it's released over
 * a label drop target.
 */
export function beginTileDrag(e: React.PointerEvent, key: number, title: string, onDrop: (labelId: string) => void) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
    if (!dragging) document.body.style.userSelect = "none";
    dragging = true;
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-label-drop]");
    useDrag.setState({ key, title, x: ev.clientX, y: ev.clientY, over: target?.dataset.labelDrop ?? null });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (dragging) {
      document.body.style.userSelect = "";
      justDragged = true;
      const over = useDrag.getState().over;
      if (over) onDrop(over);
      setTimeout(() => (justDragged = false), 0);
    }
    useDrag.setState({ key: null, over: null });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
