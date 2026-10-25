// Pointer-based dragging: tiles onto sidebar labels, panes and files into the window's splits
// (an edge of a split, or of the whole area from the grid), and rows within a list (labels).
// (HTML5 drag-and-drop is swallowed by the WebView's native file-drop handling on Windows, so we
// track pointers ourselves.)

import { create } from "zustand";

import { type Edge, type Target, MAX_LEAVES, edgeAt, leaves } from "../lib/layoutTree";
import { dropGap } from "../lib/reorder";
import { useLayout } from "./layout";

/** Where a drag would land in the layout: an edge of leaf `leaf`, or of the whole area (null). */
export interface LayoutDrop {
  leaf: string | null;
  edge: Edge;
}

interface DragState {
  /** Pane key being dragged (after the pointer moved far enough to count as a drag). */
  key: number | null;
  title: string;
  x: number;
  y: number;
  /** Label id under the pointer, if any (drop targets carry `data-label-drop`). */
  over: string | null;
  /** Something is being dragged (a pane or a file). */
  dragging: boolean;
  /** Where it would go in the layout (`data-leaf` / `data-layout-drop` targets). */
  drop: LayoutDrop | null;
}

export const useDrag = create<DragState>(() => ({
  key: null,
  title: "",
  x: 0,
  y: 0,
  over: null,
  dragging: false,
  drop: null,
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
 * a label drop target; over the layout, `target` goes where it was dropped.
 */
export function beginTileDrag(e: React.PointerEvent, key: number, title: string, onDrop: (labelId: string) => void, target?: Target) {
  begin(e, key, title, onDrop, target);
}

/** Starts tracking a potential drag of an open file (into the layout only). */
export function beginFileDrag(e: React.PointerEvent, title: string, target: Target) {
  begin(e, null, title, () => {}, target);
}

function layoutDropAt(x: number, y: number, el: Element | null): LayoutDrop | null {
  // With four splits already, a drop replaces what's there.
  const full = leaves(useLayout.getState().root).length >= MAX_LEAVES;
  const leaf = el?.closest<HTMLElement>("[data-leaf]");
  if (leaf) return { leaf: leaf.dataset.leaf!, edge: full ? "center" : edgeAt(leaf.getBoundingClientRect(), x, y) };
  const area = el?.closest<HTMLElement>("[data-layout-drop]");
  return area ? { leaf: null, edge: full ? "center" : edgeAt(area.getBoundingClientRect(), x, y) } : null;
}

function begin(e: React.PointerEvent, key: number | null, title: string, onDrop: (labelId: string) => void, target?: Target) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
    if (!dragging) document.body.style.userSelect = "none";
    dragging = true;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const label = key === null ? null : el?.closest<HTMLElement>("[data-label-drop]");
    const drop = target && !label ? layoutDropAt(ev.clientX, ev.clientY, el) : null;
    useDrag.setState({ key, title, x: ev.clientX, y: ev.clientY, over: label?.dataset.labelDrop ?? null, dragging: true, drop });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (dragging) {
      document.body.style.userSelect = "";
      justDragged = true;
      const { over, drop } = useDrag.getState();
      if (over) onDrop(over);
      else if (drop && target) {
        const layout = useLayout.getState();
        // The whole area's center from the grid: show it alone (the splits it replaces can come back).
        if (drop.leaf === null && drop.edge === "center") layout.show(target);
        else layout.place(drop.leaf, drop.edge, target);
      }
      setTimeout(() => (justDragged = false), 0);
    }
    useDrag.setState({ key: null, over: null, dragging: false, drop: null });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * Starts tracking a potential drag of a row to another place in its list. The rows are the
 * elements inside `list` carrying `data-reorder`, top to bottom. `onGap` follows the pointer
 * with the gap the row would land in (0 = before the first row), and gets `null` when the drag
 * ends; `onDrop(gap)` runs on release. Escape cancels, and the click that follows a drag is
 * swallowed (`consumeJustDragged`). A drag handle (touch) passes a small `threshold`.
 */
export function beginReorderDrag(
  e: React.PointerEvent,
  list: HTMLElement | null,
  onGap: (gap: number | null) => void,
  onDrop: (gap: number) => void,
  threshold = THRESHOLD,
) {
  if (e.button !== 0 || !list) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const pointer = e.pointerId;
  let dragging = false;
  let cancelled = false;
  let gap: number | null = null;
  const rows = () => [...list.querySelectorAll<HTMLElement>("[data-reorder]")].map((el) => el.getBoundingClientRect());
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer || cancelled) return;
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return;
    if (!dragging) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
    }
    dragging = true;
    gap = dropGap(ev.clientY, rows());
    onGap(gap);
  };
  const stop = () => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    onGap(null);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    if (!dragging) return;
    if (!cancelled) stop();
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
    if (drop && !cancelled && gap !== null) onDrop(gap);
  };
  const up = (ev: PointerEvent) => ev.pointerId === pointer && finish(true);
  const cancel = (ev: PointerEvent) => ev.pointerId === pointer && finish(false);
  // Escape drops nothing; the button's release (and its click) are still ours.
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging || cancelled) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelled = true;
    stop();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
