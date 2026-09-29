import { describe, expect, it } from "vitest";

import { appMod, historyStep, isDeleteKey, keyLabel } from "./platform";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("platform keys", () => {
  it("uses ⌘ for the app on macOS and leaves Ctrl to the terminal", () => {
    expect(appMod({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(appMod({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(appMod({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(appMod({ ctrlKey: false, metaKey: true }, false)).toBe(false);
  });

  it("labels shortcuts per platform", () => {
    expect(keyLabel("Mod+Shift+C", true)).toBe("⇧⌘C");
    expect(keyLabel("Mod+Shift+C", false)).toBe("Ctrl+Shift+C");
    expect(keyLabel("Mod+Enter", true)).toBe("⌘↩");
    expect(keyLabel("Mod+F", false)).toBe("Ctrl+F");
    expect(keyLabel("Alt+←", true)).toBe("⌥←");
    expect(keyLabel("F2", true)).toBe("F2");
    expect(keyLabel("Delete", true)).toBe("⌘⌫");
    expect(keyLabel("Delete", false)).toBe("Del");
  });

  it("steps through folder history", () => {
    expect(historyStep(key("ArrowLeft", { altKey: true }), false)).toBe(-1);
    expect(historyStep(key("ArrowRight", { altKey: true }), true)).toBe(1);
    expect(historyStep(key("[", { metaKey: true }), true)).toBe(-1);
    expect(historyStep(key("]", { metaKey: true }), true)).toBe(1);
    expect(historyStep(key("[", { metaKey: true }), false)).toBe(0);
    expect(historyStep(key("ArrowLeft"), true)).toBe(0);
  });

  it("deletes with Delete, and ⌘⌫ on macOS", () => {
    expect(isDeleteKey(key("Delete"), false)).toBe(true);
    expect(isDeleteKey(key("Backspace", { metaKey: true }), true)).toBe(true);
    expect(isDeleteKey(key("Backspace", { metaKey: true }), false)).toBe(false);
    expect(isDeleteKey(key("Backspace"), true)).toBe(false);
  });
});
