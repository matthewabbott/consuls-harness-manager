// UI preferences kept by the core in config.json (default folders, recording mode): they must
// survive quitting, crashes and a wiped WebView profile, which localStorage doesn't promise.

import { backend } from "../ipc/backend";
import type { UiPrefs } from "../ipc/bindings/UiPrefs";
import { useApp } from "./app";

/** Changes some preferences: applied here at once, saved by the core (which echoes a Config event). */
export function updateUiPrefs(patch: Partial<UiPrefs>) {
  const app = useApp.getState();
  const ui = { ...app.config.ui, ...patch };
  useApp.setState({ config: { ...app.config, ui } });
  void backend()
    .then((b) => b.setUiPrefs(ui))
    .catch((e) => app.notify("error", `Couldn't save preferences: ${e}`));
}

export function setDefaultFolder(host: string, path: string | null) {
  const defaultFolders = { ...useApp.getState().config.ui.defaultFolders };
  if (path) defaultFolders[host] = path;
  else delete defaultFolders[host];
  updateUiPrefs({ defaultFolders });
}

export const useDefaultFolder = (host: string): string | null => useApp((s) => s.config.ui.defaultFolders[host] ?? null);

/** Default folders starred before they moved to config.json lived in localStorage: bring them over once. */
export function migrateLocalDefaults() {
  try {
    const raw = localStorage.getItem("consuls.files.v1");
    if (!raw) return;
    const old = (JSON.parse(raw)?.state?.defaults ?? {}) as Record<string, string>;
    const current = useApp.getState().config.ui.defaultFolders;
    const missing = Object.fromEntries(Object.entries(old).filter(([h]) => !(h in current)));
    if (Object.keys(missing).length > 0) updateUiPrefs({ defaultFolders: { ...current, ...missing } });
    localStorage.removeItem("consuls.files.v1");
  } catch {
    /* storage unavailable or unreadable: nothing to bring over */
  }
}
