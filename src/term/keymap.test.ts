import { describe, expect, it } from "vitest";
import { tmuxKey, type KeyLike } from "./keymap";

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe("tmuxKey", () => {
  it("maps named keys", () => {
    expect(tmuxKey(k("Enter"))).toBe("Enter");
    expect(tmuxKey(k("Escape"))).toBe("Escape");
    expect(tmuxKey(k("ArrowUp"))).toBe("Up");
    expect(tmuxKey(k("Backspace"))).toBe("BSpace");
    expect(tmuxKey(k("F5"))).toBe("F5");
    expect(tmuxKey(k("PageDown"))).toBe("NPage");
  });

  it("applies modifiers", () => {
    expect(tmuxKey(k("ArrowLeft", { ctrlKey: true }))).toBe("C-Left");
    expect(tmuxKey(k("ArrowRight", { altKey: true, shiftKey: true }))).toBe("M-S-Right");
    expect(tmuxKey(k("Tab", { shiftKey: true }))).toBe("BTab");
    expect(tmuxKey(k("Enter", { shiftKey: true }))).toBe("C-j");
  });

  it("maps control and meta characters", () => {
    expect(tmuxKey(k("c", { ctrlKey: true }))).toBe("C-c");
    expect(tmuxKey(k("O", { ctrlKey: true, shiftKey: true }))).toBe("C-o");
    expect(tmuxKey(k(" ", { ctrlKey: true }))).toBe("C-Space");
    expect(tmuxKey(k("f", { altKey: true }))).toBe("M-f");
  });

  it("leaves text to onData", () => {
    expect(tmuxKey(k("a"))).toBeNull();
    expect(tmuxKey(k("A", { shiftKey: true }))).toBeNull();
    expect(tmuxKey(k("@", { ctrlKey: true, altKey: true }))).toBeNull(); // AltGr
    expect(tmuxKey(k("Shift", { shiftKey: true }))).toBeNull();
  });

  it("treats Option as Meta on macOS", () => {
    // Option+B reports "∫", Option+E a dead key: the key code says which key it was.
    expect(tmuxKey(k("∫", { altKey: true, keyCode: 66 }), true)).toBe("M-b");
    expect(tmuxKey(k("Dead", { altKey: true, keyCode: 69 }), true)).toBe("M-e");
    expect(tmuxKey(k("ı", { altKey: true, shiftKey: true, keyCode: 66 }), true)).toBe("M-B");
    expect(tmuxKey(k("≥", { altKey: true, keyCode: 190 }), true)).toBe("M-.");
    expect(tmuxKey(k("ArrowLeft", { altKey: true, keyCode: 37 }), true)).toBe("M-Left");
    // Ctrl stays the terminal's, ⌘ the app's.
    expect(tmuxKey(k("c", { ctrlKey: true, keyCode: 67 }), true)).toBe("C-c");
    expect(tmuxKey(k("c", { metaKey: true, keyCode: 67 }), true)).toBeNull();
  });
});
