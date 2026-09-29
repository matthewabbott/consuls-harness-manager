// Maps browser key events to tmux key names for `send-keys`, so tmux encodes them for the
// pane's real terminal modes (cursor-key mode, keypad mode, …). Plain printable text is
// left to xterm's onData (which also handles IME) and sent with `send-keys -l`.

import { isMac } from "../lib/platform";

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
  /** The layout's key code: on macOS, Option+key reports a composed character (Option+B is
   * "∫", Option+E a dead key) and this is how to get the key back. */
  keyCode?: number;
}

/** Punctuation key codes: the character without and with Shift (US layout). */
const PUNCT: Record<number, [string, string]> = {
  186: [";", ":"],
  187: ["=", "+"],
  188: [",", "<"],
  189: ["-", "_"],
  190: [".", ">"],
  191: ["/", "?"],
  192: ["`", "~"],
  219: ["[", "{"],
  220: ["\\", "|"],
  221: ["]", "}"],
  222: ["'", '"'],
};

/** The key under Option on macOS, where Option acts as Meta (like xterm's `macOptionIsMeta`). */
function optionBase(e: KeyLike): string | null {
  const c = e.keyCode;
  if (c === undefined) return null;
  if (c >= 65 && c <= 90) {
    const ch = String.fromCharCode(c);
    return e.shiftKey ? ch : ch.toLowerCase();
  }
  if (c >= 48 && c <= 57 && !e.shiftKey) return String.fromCharCode(c);
  if (c === 32) return "Space";
  const p = PUNCT[c];
  return p ? p[e.shiftKey ? 1 : 0] : null;
}

/** Returns the tmux key to send, or `null` to let the key produce text normally. */
export function tmuxKey(e: KeyLike, mac = isMac): string | null {
  // AltGr on many keyboards reports Ctrl+Alt; those produce characters, not shortcuts. (⌘ is
  // the app's, on macOS.)
  const altGr = !mac && e.ctrlKey && e.altKey && e.key.length === 1;
  if (altGr || e.metaKey) return null;

  const named = NAMED[e.key];
  if (named) {
    if (named === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey) return "BTab";
    // Shift+Enter inserts a newline in agent prompts; Ctrl+J (LF) is understood by
    // Claude Code, Codex and omp without special terminal setup.
    if (named === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) return "C-j";
    return `${e.ctrlKey ? "C-" : ""}${e.altKey ? "M-" : ""}${e.shiftKey && named !== "Tab" ? "S-" : ""}${named}`;
  }

  if (mac && e.altKey && !e.ctrlKey) {
    const base = optionBase(e);
    if (base) return `M-${base}`;
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
