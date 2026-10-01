// Helpers for talking about panes independent of how they're hosted (tmux or direct).

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { shortPath } from "./hosts";

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

/** Strip the status glyph some harnesses prefix to their terminal title. */
export function cleanTitle(title: string): string {
  return title.replace(/^[✳✻✶✢·◐◑◒◓⠀-⣿*•]+\s*/u, "").trim();
}

/**
 * A bare hostname (tmux's default pane title): `host.domain.tld` with no spaces, or a name on a
 * home network (`MBAs-MacBook-Pro.local`, `box.lan`). One dot alone (`notes.md`) doesn't count.
 */
export function looksLikeHostname(t: string): boolean {
  return /^[\w-]+(\.[\w-]+){2,}$/.test(t) || /^[\w-]+\.(local|lan|home|internal|localdomain)$/i.test(t);
}

/** What to call a pane: its name, else a useful title, else its folder or window. */
export function displayTitle(p: PaneInfo): string {
  if (p.name) return p.name;
  const t = cleanTitle(p.title);
  // Shells title themselves with the host, user@host:path, or (Windows) their exe path /
  // `MINGW64:/…`; a program that sets no title leaves tmux's default, the hostname
  // (`MBAs-MacBook-Pro.local` on macOS). None of those beat the folder.
  const noise = /^[\w.-]+@[\w.-]+:/.test(t) || /^[A-Za-z]:[\\/]/.test(t) || /^MINGW(32|64):/.test(t) || looksLikeHostname(t);
  if (t && t !== p.host && !t.startsWith(p.host + ":") && !noise) return t;
  if (p.harness === "shell" || p.harness === null) return shortPath(p.currentPath);
  return paneName(p);
}
