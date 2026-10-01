// Keys from the phone's key bar, and characters typed while its Ctrl/Alt is held.

export interface HeldMods {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODS: HeldMods = { ctrl: false, alt: false };

/** tmux's name for `name` (a tmux key name like `Left`, or one character) with the held modifiers. */
export function tmuxName(name: string, mods: HeldMods): string {
  const base = mods.ctrl && /^[A-Z]$/.test(name) ? name.toLowerCase() : name;
  return (mods.ctrl ? "C-" : "") + (mods.alt ? "M-" : "") + base;
}

const RAW: Record<string, string> = {
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PPage: "\x1b[5~",
  NPage: "\x1b[6~",
  Escape: "\x1b",
  Tab: "\t",
  BTab: "\x1b[Z",
  Enter: "\r",
  BSpace: "\x7f",
  Space: " ",
};

/** The same key as bytes, for a pane without tmux (xterm's encoding). */
export function rawBytes(name: string, mods: HeldMods): string {
  let s = RAW[name] ?? name;
  if (mods.ctrl && s.length === 1) {
    const c = s.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) s = String.fromCharCode(c - 64); // Ctrl+@, A–Z, [, \, ], ^, _
    else if (s === " ") s = "\0";
    else if (s === "?") s = "\x7f";
  }
  return mods.alt ? `\x1b${s}` : s;
}
