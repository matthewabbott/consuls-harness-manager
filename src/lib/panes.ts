// Helpers for talking about panes independent of how they're stored.

export interface PaneLike {
  host: string;
  chmId: string | null;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
}

/**
 * Stable identity for a pane across app restarts, used to key per-pane drafts, history and
 * view preferences: our `@chm_id` tag when the pane has one, otherwise its tmux location.
 */
export function paneIdentity(p: PaneLike): string {
  return p.chmId ? `${p.host}#${p.chmId}` : `${p.host}:${p.sessionName}:${p.windowIndex}.${p.paneIndex}`;
}
