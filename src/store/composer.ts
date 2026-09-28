// Per-pane composer drafts and prompt history, persisted locally so a half-written prompt
// survives switching panes or restarting the app.

const DRAFTS = "consuls.drafts.v1";
const HISTORY = "consuls.history.v1";
const MAX_HISTORY = 100;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: drafts are a convenience */
  }
}

const drafts: Record<string, string> = load(DRAFTS, {});
const history: Record<string, string[]> = load(HISTORY, {});
let saveTimer = 0;

/** Stable identity for a pane across app restarts: host + tmux ids (or our @chm_id). */
export function paneIdentity(p: { host: string; chmId: string | null; sessionName: string; windowIndex: number; paneIndex: number }): string {
  return p.chmId ? `${p.host}#${p.chmId}` : `${p.host}:${p.sessionName}:${p.windowIndex}.${p.paneIndex}`;
}

export function getDraft(id: string): string {
  return drafts[id] ?? "";
}

export function setDraft(id: string, text: string) {
  if (text) drafts[id] = text;
  else delete drafts[id];
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save(DRAFTS, drafts), 400);
}

export function getHistory(id: string): string[] {
  return history[id] ?? [];
}

export function pushHistory(id: string, text: string) {
  const list = (history[id] ?? []).filter((t) => t !== text);
  list.push(text);
  history[id] = list.slice(-MAX_HISTORY);
  save(HISTORY, history);
}
