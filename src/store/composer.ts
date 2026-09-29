// Per-pane composer drafts and prompt history, kept in the UI's own state (lib/uiState.ts) so
// a half-written prompt survives switching panes or restarting the app.

import { uiStorage } from "../lib/uiState";

const DRAFTS = "consuls.drafts.v1";
const HISTORY = "consuls.history.v1";
const MAX_HISTORY = 100;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = uiStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const save = (key: string, value: unknown) => uiStorage.setItem(key, JSON.stringify(value));

// Read on first use: the state arrives from the core after this module loads.
let draftsCache: Record<string, string> | null = null;
let historyCache: Record<string, string[]> | null = null;
const drafts = () => (draftsCache ??= load<Record<string, string>>(DRAFTS, {}));
const history = () => (historyCache ??= load<Record<string, string[]>>(HISTORY, {}));
let saveTimer = 0;

/** Moves a pane's draft and history to a new identity (it gained a stable @chm_id). */
export function renameIdentity(from: string, to: string) {
  const d = drafts();
  const h = history();
  if (d[from] !== undefined && d[to] === undefined) {
    d[to] = d[from];
    delete d[from];
    save(DRAFTS, d);
  }
  if (h[from] && !h[to]) {
    h[to] = h[from];
    delete h[from];
    save(HISTORY, h);
  }
}

export function getDraft(id: string): string {
  return drafts()[id] ?? "";
}

export function setDraft(id: string, text: string) {
  const d = drafts();
  if (text) d[id] = text;
  else delete d[id];
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save(DRAFTS, d), 400);
}

export function getHistory(id: string): string[] {
  return history()[id] ?? [];
}

export function pushHistory(id: string, text: string) {
  const h = history();
  const list = (h[id] ?? []).filter((t) => t !== text);
  list.push(text);
  h[id] = list.slice(-MAX_HISTORY);
  save(HISTORY, h);
}
