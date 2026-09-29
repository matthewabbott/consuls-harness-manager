// The UI's own per-device state: layout, text zoom, composer drafts and history, and the new
// pane dialog's last choices. The core keeps it in ui-state.json, because WebView2's storage
// can lose recent writes when the app quits (and once lost everything). `uiStorage` is a
// synchronous view of it, for zustand's persist; call `loadUiState` before rendering.

import type { StateStorage } from "zustand/middleware";

import { backend } from "../ipc/backend";

let values: Record<string, string> = {};

/** What used to live in localStorage: moved over once, then removed from there. */
const LEGACY = ["consuls.ui.v1", "consuls.viewprefs.v1", "consuls.drafts.v1", "consuls.history.v1", "consuls.newPane.harness", "consuls.newPane.localShell"];

export async function loadUiState(): Promise<void> {
  const b = await backend();
  values = await b.getUiState().catch(() => ({}));
  for (const key of LEGACY) {
    try {
      const old = localStorage.getItem(key);
      if (old === null) continue;
      if (values[key] === undefined) uiStorage.setItem(key, old);
      localStorage.removeItem(key);
    } catch {
      /* no localStorage: nothing to move */
    }
  }
}

export const uiStorage = {
  getItem: (key: string): string | null => values[key] ?? null,
  setItem: (key: string, value: string) => {
    if (values[key] === value) return;
    values[key] = value;
    void backend().then((b) => b.setUiState(key, value)).catch(() => undefined);
  },
  removeItem: (key: string) => {
    if (!(key in values)) return;
    delete values[key];
    void backend().then((b) => b.setUiState(key, null)).catch(() => undefined);
  },
} satisfies StateStorage;
