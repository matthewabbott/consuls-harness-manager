// Hotkeys: digits 1–9 bound to panes and files (layout targets), shared by the app's windows.
// The keys themselves are in `lib/hotkeys.ts`; the handler is in App.tsx.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { Target } from "../lib/layoutTree";
import { onUiStateChange, uiStorage } from "../lib/uiState";

interface HotkeyState {
  /** Digit → what it jumps to. */
  keys: Record<string, Target>;
  /** Binds `digit` to `target` (its only digit); binding the same pair again unbinds it. */
  assign(digit: number, target: Target): void;
  rename(from: Target, to: Target): void;
}

export const useHotkeys = create<HotkeyState>()(
  persist(
    (set) => ({
      keys: {},
      assign: (digit, target) =>
        set((s) => {
          const keys = Object.fromEntries(Object.entries(s.keys).filter(([, t]) => t !== target));
          if (s.keys[digit] !== target) keys[digit] = target;
          return { keys };
        }),
      rename: (from, to) => set((s) => ({ keys: Object.fromEntries(Object.entries(s.keys).map(([d, t]) => [d, t === from ? to : t])) })),
    }),
    { name: "consuls.hotkeys.v1", storage: createJSONStorage(() => uiStorage), skipHydration: true },
  ),
);

// Another window bound a key.
onUiStateChange("consuls.hotkeys.v1", () => void useHotkeys.persist.rehydrate());

export const digitOf = (keys: Record<string, Target>, target: Target): number | null => {
  const d = Object.entries(keys).find(([, t]) => t === target)?.[0];
  return d ? Number(d) : null;
};
