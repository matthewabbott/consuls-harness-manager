// tmux's prefix keys in the expanded view of a tmux pane. The app is the "client" here, so it
// runs tmux's stock bindings itself, aimed at the pane on screen: tmux's own commands for what
// changes tmux (split, new window, renames), the app's equivalents for what a client does
// (detach = back to the grid, next window = show that window's pane). Running the keys
// through tmux instead would act on whatever pane the app's control client has current, move
// other devices viewing the session, and detach the app itself on Ctrl+B d.

export type PrefixAction =
  | { kind: "sendPrefix" }
  | { kind: "grid" }
  | { kind: "newWindow" }
  | { kind: "split"; horizontal: boolean }
  | { kind: "close" }
  | { kind: "zoom" }
  | { kind: "window"; which: "next" | "prev" | number }
  | { kind: "nextPane" }
  | { kind: "rename"; what: "window" | "session" }
  | { kind: "help" }
  | { kind: "cancel" }
  | { kind: "unknown" };

/** The key pressed after the prefix: its character (`e.key`) and tmux name (`tmuxKey`). */
export function prefixAction(key: string, tmuxName: string | null, prefix: string): PrefixAction {
  if (tmuxName === prefix || key === prefix) return { kind: "sendPrefix" };
  if (key === "Escape") return { kind: "cancel" };
  if (/^[0-9]$/.test(key)) return { kind: "window", which: Number(key) };
  switch (key) {
    case "d":
    case "s":
    case "w":
      return { kind: "grid" };
    case "c":
      return { kind: "newWindow" };
    case "%":
      return { kind: "split", horizontal: true };
    case '"':
      return { kind: "split", horizontal: false };
    case "x":
      return { kind: "close" };
    case "z":
      return { kind: "zoom" };
    case "n":
      return { kind: "window", which: "next" };
    case "p":
      return { kind: "window", which: "prev" };
    case "o":
      return { kind: "nextPane" };
    case ",":
      return { kind: "rename", what: "window" };
    case "$":
      return { kind: "rename", what: "session" };
    case "?":
      return { kind: "help" };
    default:
      return { kind: "unknown" };
  }
}

/** Whether a keydown is the prefix itself (a tmux key name such as `C-b`, or a plain character). */
export function isPrefix(key: string, tmuxName: string | null, prefix: string): boolean {
  return tmuxName === prefix || (prefix.length === 1 && key === prefix);
}

/** `C-b` → `Ctrl+B`, `M-a` → `Alt+A`. */
export function prefixLabel(prefix: string): string {
  return prefix
    .split("-")
    .map((part, i, all) => (i < all.length - 1 ? ({ C: "Ctrl", M: "Alt", S: "Shift" }[part] ?? part) : part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

/** For the Ctrl+B ? sheet. */
export const PREFIX_HELP: [string, string][] = [
  ["d  s  w", "Back to the grid (it keeps running)"],
  ["c", "New window in this session"],
  ["%  \"", "Split side by side / one above the other"],
  ["n  p  0–9", "Next, previous or numbered window"],
  ["o", "Next pane in this window"],
  [",  $", "Rename the window / session (in tmux)"],
  ["z", "Maximize"],
  ["x", "Quit & close this pane"],
  ["prefix again", "Send the prefix key to the program"],
];

export interface WindowPane {
  key: number;
  windowIndex: number;
  paneIndex: number;
  paneActive: boolean;
}

/** The pane to show for `which` window among a session's panes (its active pane). */
export function windowTarget(panes: WindowPane[], current: WindowPane, which: "next" | "prev" | number): number | null {
  const windows = [...new Set(panes.map((p) => p.windowIndex))].sort((a, b) => a - b);
  let index: number | undefined;
  if (typeof which === "number") index = windows.includes(which) ? which : undefined;
  else {
    const at = windows.indexOf(current.windowIndex);
    index = windows[(at + (which === "next" ? 1 : -1) + windows.length) % windows.length];
  }
  if (index === undefined) return null;
  const inWindow = panes.filter((p) => p.windowIndex === index).sort((a, b) => a.paneIndex - b.paneIndex);
  return (inWindow.find((p) => p.paneActive) ?? inWindow[0])?.key ?? null;
}

/** The next pane in the current pane's window. */
export function nextPaneTarget(panes: WindowPane[], current: WindowPane): number | null {
  const inWindow = panes.filter((p) => p.windowIndex === current.windowIndex).sort((a, b) => a.paneIndex - b.paneIndex);
  if (inWindow.length < 2) return null;
  const at = inWindow.findIndex((p) => p.key === current.key);
  return inWindow[(at + 1) % inWindow.length].key;
}
