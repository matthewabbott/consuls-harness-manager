// Dragging explorer items with the mouse: onto a folder (in the tree, or a crumb or place above
// it) to move them there (Option / Alt: copy), or out of the window to Finder / File Explorer.
// Pointer events, not HTML5 drag and drop: the window's native file drop stays on.
//
// Out of the window, the system's drag takes over; it carries files on this computer, so a
// file from another machine starts downloading to a temporary folder as soon as the drag begins.

import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import { isLocal } from "../lib/hosts";
import { isWithin, parentPath, sameFolder } from "../lib/paths";

/** Largest file fetched just in case it's dragged out (the shell refuses bigger ones too). */
const OUT_LIMIT = 256 * 1024 * 1024;
const THRESHOLD = 5;

export interface Dragged {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export interface TreeDrag {
  item: Dragged;
  x: number;
  y: number;
  /** The folder it would go into, if it can. */
  target: string | null;
  copy: boolean;
  /** Dragging it out: a local copy being fetched, ready, or why it can't. */
  out: { state: "fetching" | "ready" } | { state: "no"; why: string };
}

/** The folder under the pointer: a crumb or place, a folder row (a file row: its folder), the empty space (the root). */
export function folderAt(x: number, y: number, root: string): string | null {
  const el = document.elementFromPoint(x, y);
  const place = el?.closest<HTMLElement>("[data-drop-dir]");
  if (place?.dataset.dropDir) return place.dataset.dropDir;
  const row = el?.closest<HTMLElement>("[data-path]");
  if (row?.dataset.path) return row.dataset.dir ? row.dataset.path : parentPath(row.dataset.path);
  return el?.closest("[data-drop-root]") ? root : null;
}

/** Whether `item` can go into `dir` (a move to where it is does nothing; nothing goes inside itself). */
export function canDrop(item: Dragged, dir: string, copy: boolean): boolean {
  if (item.isDir && isWithin(dir, item.path)) return false;
  return copy || !sameFolder(dir, parentPath(item.path));
}

export function useTreeDrag(host: string | null, root: string | null, onDrop: (item: Dragged, dir: string, copy: boolean) => void) {
  const [drag, setDrag] = useState<TreeDrag | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const hostRef = useRef({ host, root, onDrop });
  hostRef.current = { host, root, onDrop };
  useEffect(() => () => cleanup.current?.(), []);

  /** On a row's pointerdown: becomes a drag once the pointer moves a little. */
  const begin = (e: React.PointerEvent, item: Dragged) => {
    if (e.button !== 0 || !hostRef.current.host) return;
    cleanup.current?.();
    const from = hostRef.current.host;
    const start = { x: e.clientX, y: e.clientY };
    const capture = e.currentTarget.closest("[data-drop-root]") ?? e.currentTarget;
    const pointer = e.pointerId;
    let live: TreeDrag | null = null;
    let local: string | null = null; // the local copy, once fetched
    let outside = false;
    let handedOff = false;

    const handOff = () => {
      if (handedOff || !local) return;
      handedOff = true;
      void backend().then((b) => b.startDragOut([local!]));
      finish();
    };
    const fetchCopy = () => {
      const remote = !isLocal(from);
      if (remote && item.isDir) return { state: "no" as const, why: "Folders from other machines can't be dragged out (use Download… on their files)" };
      if (remote && item.size > OUT_LIMIT) return { state: "no" as const, why: "Too large to drag out: use Download…" };
      void backend()
        .then((b) => b.prepareDrag(from, item.path))
        .then(
          (path) => {
            local = path;
            if (live) live = { ...live, out: { state: "ready" } };
            setDrag(live);
            if (outside) handOff(); // it was waiting outside the window
          },
          (why) => {
            if (live) live = { ...live, out: { state: "no", why: String(why) } };
            setDrag(live);
          },
        );
      return { state: "fetching" as const };
    };

    const move = (ev: PointerEvent) => {
      if (!live) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
        try {
          capture.setPointerCapture(pointer);
        } catch {
          /* the row went away */
        }
        live = { item, x: ev.clientX, y: ev.clientY, target: null, copy: ev.altKey, out: { state: "fetching" } };
        live.out = fetchCopy();
      }
      outside = ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
      if (outside && ev.buttons & 1) {
        if (local) return handOff();
      }
      const root = hostRef.current.root;
      const dir = !outside && root ? folderAt(ev.clientX, ev.clientY, root) : null;
      const copy = ev.altKey;
      live = { ...live, x: ev.clientX, y: ev.clientY, copy, target: dir && canDrop(item, dir, copy) ? dir : null };
      setDrag(live);
    };
    const swallow = (c: MouseEvent) => c.stopPropagation();
    const up = (ev: PointerEvent) => {
      const dropped = live;
      finish();
      if (!dropped) return;
      // The click that follows a drag (in this same turn of the event loop) isn't one.
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (dropped.target && hostRef.current.host === from) hostRef.current.onDrop(item, dropped.target, ev.altKey);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish();
      // Option on a Mac reports as Alt.
      else if (live && ev.key === "Alt") setDrag((live = { ...live, copy: ev.type === "keydown" }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      try {
        capture.releasePointerCapture(pointer);
      } catch {
        /* already released */
      }
      live = null;
      cleanup.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    cleanup.current = finish;
  };

  return { drag, begin };
}
