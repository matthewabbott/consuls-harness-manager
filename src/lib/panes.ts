// Helpers for talking about panes independent of how they're hosted (tmux or direct).

import type { PaneInfo } from "../ipc/bindings/PaneInfo";

export type PaneLike = Pick<PaneInfo, "host" | "key" | "chmId" | "tmux">;

/**
 * Stable identity for a pane across app restarts, used to key per-pane drafts, history and
 * view preferences: our `@chm_id` tag when the pane has one, otherwise its tmux location.
 */
export function paneIdentity(p: PaneLike): string {
  if (p.chmId) return `${p.host}#${p.chmId}`;
  if (p.tmux) return `${p.host}:${p.tmux.sessionName}:${p.tmux.windowIndex}.${p.tmux.paneIndex}`;
  return `${p.host}#key${p.key}`;
}

/** Where the pane lives: `session:window[.pane]` for tmux panes, "direct" otherwise. */
export function paneWhere(p: PaneInfo, full = false): string {
  const t = p.tmux;
  if (!t) return p.ended ? "ended" : "direct";
  const withPane = full || t.paneIndex > 1 || !t.paneActive;
  return `${t.sessionName}:${t.windowIndex}${withPane ? `.${t.paneIndex}` : ""}`;
}

/** The tmux window name, or what's running in a direct pane. */
export function paneName(p: PaneInfo): string {
  return p.tmux?.windowName ?? p.currentCommand;
}

export const isDirect = (p: PaneInfo): boolean => p.kind === "direct";
