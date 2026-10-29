// What the notifications list has shown you: alerts after `seenAt` count as unread, and Clear
// hides everything up to `clearedAt` (unix seconds, so they hold across core restarts, whose
// alert ids start over). Kept in the UI state, so the app's windows agree.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { onUiStateChange, uiStorage } from "../lib/uiState";

interface AlertsSeen {
  seenAt: number;
  clearedAt: number;
  markSeen(at: number): void;
  clear(at: number): void;
}

export const useAlertsSeen = create<AlertsSeen>()(
  persist(
    (set) => ({
      seenAt: 0,
      clearedAt: 0,
      markSeen: (at) => set((s) => (at > s.seenAt ? { seenAt: at } : s)),
      clear: (at) => set((s) => ({ clearedAt: Math.max(at, s.clearedAt), seenAt: Math.max(at, s.seenAt) })),
    }),
    { name: "consuls.alerts.v1", storage: createJSONStorage(() => uiStorage), skipHydration: true },
  ),
);

// Another window read or cleared the list.
onUiStateChange("consuls.alerts.v1", () => void useAlertsSeen.persist.rehydrate());
