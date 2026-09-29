// Per-pane view preferences: text zoom, and how the tmux window is sized while expanded.
// Per device, keyed by pane identity (see lib/panes.ts).

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { uiStorage } from "../lib/uiState";

/**
 * - `fit`: resize the tmux window to fill the view (default the first time a pane is expanded).
 * - `fixed`: keep a size the user chose (drag handle / "keep this size").
 * - `scale`: leave tmux alone and scale the text to the pane's width (v1 behaviour; the default
 *   for split windows, since resizing them redraws the neighbouring panes too).
 */
export type SizeMode = "fit" | "fixed" | "scale";

export interface ViewPref {
  /** Terminal font size in px; absent = default (or width-fitted in `scale` mode). */
  fontSize?: number;
  sizeMode?: SizeMode;
  cols?: number;
  rows?: number;
  /** We've told the user that other devices see a cropped window while it's pinned. */
  warnedOthers?: boolean;
}

export const FONT = { min: 8, max: 28, step: 1, default: 13 };

interface ViewPrefsState {
  prefs: Record<string, ViewPref>;
  setFontSize(id: string, size: number | null): void;
  setSizeMode(id: string, mode: SizeMode, size?: { cols: number; rows: number }): void;
  update(id: string, patch: Partial<ViewPref>): void;
  /** Moves prefs when a pane gains a stable identity. */
  rename(from: string, to: string): void;
}

export const useViewPrefs = create<ViewPrefsState>()(
  persist(
    (set) => ({
      prefs: {},
      setFontSize: (id, size) =>
        set((s) => {
          const current = { ...(s.prefs[id] ?? {}) };
          if (size === null) delete current.fontSize;
          else current.fontSize = Math.min(FONT.max, Math.max(FONT.min, Math.round(size * 2) / 2));
          return { prefs: { ...s.prefs, [id]: current } };
        }),
      setSizeMode: (id, mode, size) =>
        set((s) => ({ prefs: { ...s.prefs, [id]: { ...(s.prefs[id] ?? {}), sizeMode: mode, ...(size ?? {}) } } })),
      update: (id, patch) => set((s) => ({ prefs: { ...s.prefs, [id]: { ...(s.prefs[id] ?? {}), ...patch } } })),
      rename: (from, to) =>
        set((s) => {
          if (!s.prefs[from] || s.prefs[to]) return s;
          const prefs = { ...s.prefs, [to]: s.prefs[from] };
          delete prefs[from];
          return { prefs };
        }),
    }),
    // Loaded by main.tsx once the core has handed the state over.
    { name: "consuls.viewprefs.v1", storage: createJSONStorage(() => uiStorage), skipHydration: true },
  ),
);

/**
 * Zooms one step in (+1) or out (-1). Starts from the stored size when there is one (the store
 * updates synchronously, so rapid wheel ticks each count) and otherwise from `rendered`.
 */
export function zoom(id: string, rendered: number, dir: 1 | -1) {
  const current = useViewPrefs.getState().prefs[id]?.fontSize ?? rendered;
  useViewPrefs.getState().setFontSize(id, current + dir * FONT.step);
}
