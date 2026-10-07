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

/** Keys whose modified forms are `CSI 1;<mod> X` or `CSI n;<mod> ~` (xterm). */
const CSI: Record<string, [string, string]> = {
  Up: ["1", "A"],
  Down: ["1", "B"],
  Right: ["1", "C"],
  Left: ["1", "D"],
  Home: ["1", "H"],
  End: ["1", "F"],
  PPage: ["5", "~"],
  NPage: ["6", "~"],
};

/**
 * The same key as bytes, for a pane without tmux (xterm's encoding). Takes tmux-style names
 * with their own modifiers too (`C-c`, `M-x`, `C-M-Up`).
 */
export function rawBytes(name: string, mods: HeldMods, shift = false): string {
  const named = name.match(/^([CMS])-(.+)$/);
  if (named) {
    const [, m, rest] = named;
    return rawBytes(rest, { ctrl: mods.ctrl || m === "C", alt: mods.alt || m === "M" }, shift || m === "S");
  }
  const csi = CSI[name];
  if (csi && (mods.ctrl || mods.alt || shift)) {
    const p = 1 + (shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
    return csi[1] === "~" ? `\x1b[${csi[0]};${p}~` : `\x1b[1;${p}${csi[1]}`;
  }
  let s = RAW[name] ?? name;
  if (mods.ctrl && s.length === 1) {
    const c = s.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) s = String.fromCharCode(c - 64); // Ctrl+@, A–Z, [, \, ], ^, _
    else if (s === " ") s = "\0";
    else if (s === "?") s = "\x7f";
  }
  return mods.alt ? `\x1b${s}` : s;
}
