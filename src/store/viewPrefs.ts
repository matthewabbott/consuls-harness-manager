// Per-pane view preferences (text zoom now; size mode and remembered size with V2-4).
// Per device, keyed by pane identity (see lib/panes.ts).

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface ViewPref {
  /** Terminal font size in px; absent = fit the pane's width automatically. */
  fontSize?: number;
}

export const FONT = { min: 8, max: 28, step: 1 };

interface ViewPrefsState {
  prefs: Record<string, ViewPref>;
  setFontSize(id: string, size: number | null): void;
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
    }),
    { name: "consuls.viewprefs.v1", storage: createJSONStorage(() => localStorage) },
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
