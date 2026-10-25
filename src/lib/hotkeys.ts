// Hotkeys for panes and open files: a digit 1–9 jumps back to whatever it's assigned to. ⌘digit
// jumps and ⌘⌥digit assigns on macOS; Ctrl+digit and Ctrl+Shift+digit elsewhere. Keys are read
// from `e.code` (⌥ and Shift change `e.key`, and AZERTY needs Shift for digits); 0 is left out,
// since ⌘0 / Ctrl+0 resets a terminal's text size.

import { isMac, keyLabel } from "./platform";

export type HotkeyAction = { kind: "jump" | "assign"; digit: number };

interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function hotkeyAction(e: KeyLike, mac: boolean): HotkeyAction | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (!m) return null;
  const digit = Number(m[1]);
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  if (mac) {
    if (meta && !ctrl && !shift) return { kind: alt ? "assign" : "jump", digit };
  } else if (ctrl && !meta && !alt) {
    return { kind: shift ? "assign" : "jump", digit };
  }
  return null;
}

/** The keys that jump to `digit` ("⌘3", "Ctrl+3"). */
export const jumpLabel = (digit: number, mac = isMac) => keyLabel(`Mod+${digit}`, mac);
/** The keys that assign `digit` to what has focus ("⌥⌘3", "Ctrl+Shift+3"). */
export const assignLabel = (digit: number, mac = isMac) => keyLabel(mac ? `Alt+Mod+${digit}` : `Mod+Shift+${digit}`, mac);
