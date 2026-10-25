// Recent agent sessions (the desktop's History tab, the phone's Recent screen): what to call
// them, which one is open in a pane right now, and finding them.

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import type { SessionSummary } from "../ipc/bindings/SessionSummary";

/** What a session is called: the harness's title, else what it was asked first. */
export function sessionTitle(s: SessionSummary): string {
  return s.title ?? s.firstPrompt ?? s.lastPrompt ?? "Untitled session";
}

/** One line of what it's been about lately: the last prompt, unless that's the title already. */
export function sessionGist(s: SessionSummary): string | null {
  const title = sessionTitle(s);
  return [s.lastPrompt, s.firstPrompt].find((p) => p && p !== title) ?? null;
}

/** The pane the session is running in, if it is (hooks keep its id on the pane). */
export function sessionPane(s: SessionSummary, panes: PaneInfo[]): PaneInfo | null {
  return panes.find((p) => p.host === s.host && p.session === s.id && p.harness === s.harness && !p.ended) ?? null;
}

/** Every word of `query` is in its title, prompts, folder or machine. */
export function matchesQuery(s: SessionSummary, query: string, machine: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [s.title, s.firstPrompt, s.lastPrompt, s.cwd, machine].filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** How long ago, briefly: "now", "5m", "3h", "2d", then the date. */
export function ago(unixSecs: number, now = Date.now()): string {
  const secs = Math.max(0, now / 1000 - unixSecs);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d`;
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
