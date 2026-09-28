// Maps browser key events to tmux key names for `send-keys`, so tmux encodes them for the
// pane's real terminal modes (cursor-key mode, keypad mode, …). Plain printable text is
// left to xterm's onData (which also handles IME) and sent with `send-keys -l`.

const NAMED: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "BSpace",
  Escape: "Escape",
  Delete: "DC",
  Insert: "IC",
  Home: "Home",
  End: "End",
  PageUp: "PPage",
  PageDown: "NPage",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Returns the tmux key to send, or `null` to let the key produce text normally. */
export function tmuxKey(e: KeyLike): string | null {
  // AltGr on many keyboards reports Ctrl+Alt; those produce characters, not shortcuts.
  const altGr = e.ctrlKey && e.altKey && e.key.length === 1;
  if (altGr || e.metaKey) return null;

  const named = NAMED[e.key];
  if (named) {
    if (named === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey) return "BTab";
    // Shift+Enter inserts a newline in agent prompts; Ctrl+J (LF) is understood by
    // Claude Code, Codex and omp without special terminal setup.
    if (named === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) return "C-j";
    return `${e.ctrlKey ? "C-" : ""}${e.altKey ? "M-" : ""}${e.shiftKey && named !== "Tab" ? "S-" : ""}${named}`;
  }

  if (e.key.length !== 1) return null; // Shift, Control, dead keys, …

  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === " ") return "C-Space";
    if (/^[a-z]$/.test(k) || "[]\\^_@".includes(k)) return `C-${k}`;
    if (k === "/") return "C-_";
    return null;
  }
  if (e.altKey && !e.ctrlKey) return `M-${e.key}`;
  return null;
}
