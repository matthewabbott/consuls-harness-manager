// Latest tile snapshot per pane, kept outside React so frames never trigger re-renders;
// tiles subscribe and repaint their canvas directly.

import { FRAME_RAW, FRAME_RESET, FRAME_TILE, decodeTile, parseFrames, type TileSnapshot } from "../ipc/frames";
import { streamRaw, streamReset } from "./streams";

const snapshots = new Map<number, TileSnapshot>();
const listeners = new Map<number, Set<() => void>>();

export function applyFrames(buf: Uint8Array) {
  const touched = new Set<number>();
  for (const f of parseFrames(buf)) {
    if (f.kind === FRAME_TILE) {
      snapshots.set(f.key, decodeTile(f.payload));
      touched.add(f.key);
    } else if (f.kind === FRAME_RAW) {
      streamRaw(f.key, f.payload);
    } else if (f.kind === FRAME_RESET) {
      streamReset(f.key, f.payload);
    }
  }
  for (const key of touched) listeners.get(key)?.forEach((cb) => cb());
}

export function getTile(key: number): TileSnapshot | undefined {
  return snapshots.get(key);
}

export function subscribeTile(key: number, cb: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(key);
  };
}
