// Keyboard conventions per platform. On macOS the app's own shortcuts use ⌘, and Ctrl always
// belongs to the terminal: Ctrl+C interrupts (even with a selection), Ctrl+F moves the cursor,
// and Ctrl+click is a right click there anyway. Elsewhere the app's shortcuts use Ctrl.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Mods {
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Whether the app's shortcut modifier is down: ⌘ on macOS, Ctrl elsewhere. */
export function appMod(e: Mods, mac = isMac): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

interface NavKey extends Mods {
  key: string;
  altKey: boolean;
}

/** Back (-1) / forward (1) through a folder history: Alt+←/→, and also ⌘[ ⌘] on macOS. */
export function historyStep(e: NavKey, mac = isMac): -1 | 0 | 1 {
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return e.key === "ArrowLeft" ? -1 : 1;
  if (mac && e.metaKey && !e.altKey && !e.ctrlKey && (e.key === "[" || e.key === "]")) return e.key === "[" ? -1 : 1;
  return 0;
}

/** The key that deletes the selection: Delete, and ⌘⌫ on macOS (whose Delete key is Backspace). */
export function isDeleteKey(e: NavKey, mac = isMac): boolean {
  return e.key === "Delete" || (mac && e.metaKey && e.key === "Backspace");
}

const MAC_MODS: [string, string][] = [
  ["Ctrl", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Mod", "⌘"],
];
const MAC_KEYS: Record<string, string> = { Enter: "↩", Backspace: "⌫", Delete: "⌦", Escape: "⎋" };

/**
 * A shortcut's label. `Mod` is the app's modifier: `keyLabel("Mod+Shift+C")` is "⌘⇧C" on macOS
 * (modifiers in Apple's order) and "Ctrl+Shift+C" elsewhere. `keyLabel("Delete")` is "⌘⌫" on
 * macOS, like `isDeleteKey`.
 */
export function keyLabel(combo: string, mac = isMac): string {
  if (combo === "Delete") return mac ? "⌘⌫" : "Del";
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  if (!mac) return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), key].join("+");
  return MAC_MODS.filter(([m]) => parts.includes(m)).map(([, sym]) => sym).join("") + (MAC_KEYS[key] ?? key);
}

/** How to zoom a terminal's text with the pointer. */
export const wheelZoomLabel = isMac ? "pinch" : "Ctrl+wheel";
