// Back/forward navigation history (browser style) for the folder browsers.

export interface History<T> {
  entries: T[];
  /** The current entry; -1 while empty. */
  index: number;
}

const CAP = 50;

export function emptyHistory<T>(): History<T> {
  return { entries: [], index: -1 };
}

/** Visits `entry`: drops anything forward of the current entry. Revisiting the current entry is a no-op. */
export function pushHistory<T>(h: History<T>, entry: T, same: (a: T, b: T) => boolean): History<T> {
  const cur = h.entries[h.index];
  if (cur !== undefined && same(cur, entry)) return h;
  const entries = [...h.entries.slice(0, h.index + 1), entry].slice(-CAP);
  return { entries, index: entries.length - 1 };
}

/** The current entry turned out to have another name (e.g. `~` → `/home/u`). */
export function replaceCurrent<T>(h: History<T>, entry: T): History<T> {
  if (h.index < 0) return h;
  const entries = [...h.entries];
  entries[h.index] = entry;
  return { entries, index: h.index };
}

export const canBack = (h: History<unknown>) => h.index > 0;
export const canForward = (h: History<unknown>) => h.index < h.entries.length - 1;

/** Moves back (-1) or forward (+1); null at either end. */
export function stepHistory<T>(h: History<T>, delta: -1 | 1): { history: History<T>; entry: T } | null {
  const index = h.index + delta;
  if (index < 0 || index >= h.entries.length) return null;
  return { history: { entries: h.entries, index }, entry: h.entries[index] };
}
