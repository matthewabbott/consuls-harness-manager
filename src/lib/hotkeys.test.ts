import { describe, expect, it } from "vitest";

import { assignLabel, hotkeyAction, jumpLabel } from "./hotkeys";

const key = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("hotkeyAction", () => {
  it("jumps with ⌘digit and assigns with ⌘⌥digit on macOS", () => {
    expect(hotkeyAction(key("Digit3", { metaKey: true }), true)).toEqual({ kind: "jump", digit: 3 });
    expect(hotkeyAction(key("Digit3", { metaKey: true, altKey: true }), true)).toEqual({ kind: "assign", digit: 3 });
    expect(hotkeyAction(key("Numpad9", { metaKey: true }), true)).toEqual({ kind: "jump", digit: 9 });
    // Ctrl belongs to the terminal on macOS, and ⌘⇧3 is the system's screenshot.
    expect(hotkeyAction(key("Digit3", { ctrlKey: true }), true)).toBeNull();
    expect(hotkeyAction(key("Digit3", { metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it("uses Ctrl and Ctrl+Shift elsewhere", () => {
    expect(hotkeyAction(key("Digit1", { ctrlKey: true }), false)).toEqual({ kind: "jump", digit: 1 });
    expect(hotkeyAction(key("Digit1", { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: "assign", digit: 1 });
    // Ctrl+Alt is AltGr on many layouts.
    expect(hotkeyAction(key("Digit1", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it("leaves 0, plain digits and other keys alone", () => {
    expect(hotkeyAction(key("Digit0", { metaKey: true }), true)).toBeNull();
    expect(hotkeyAction(key("Digit5"), true)).toBeNull();
    expect(hotkeyAction(key("KeyA", { metaKey: true }), true)).toBeNull();
  });

  it("labels the keys", () => {
    expect([jumpLabel(2, true), assignLabel(2, true)]).toEqual(["⌘2", "⌥⌘2"]);
    expect([jumpLabel(2, false), assignLabel(2, false)]).toEqual(["Ctrl+2", "Ctrl+Shift+2"]);
  });
});
