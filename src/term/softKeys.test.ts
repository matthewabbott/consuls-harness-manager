import { describe, expect, it } from "vitest";

import { NO_MODS, rawBytes, tmuxName } from "./softKeys";

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };

describe("soft keys", () => {
  it("names keys for tmux with the held modifiers", () => {
    expect(tmuxName("b", ctrl)).toBe("C-b");
    expect(tmuxName("B", ctrl)).toBe("C-b");
    expect(tmuxName("Left", ctrl)).toBe("C-Left");
    expect(tmuxName("x", alt)).toBe("M-x");
    expect(tmuxName("x", { ctrl: true, alt: true })).toBe("C-M-x");
    expect(tmuxName("PPage", NO_MODS)).toBe("PPage");
  });

  it("encodes them for panes without tmux", () => {
    expect(rawBytes("c", ctrl)).toBe("\x03");
    expect(rawBytes("[", ctrl)).toBe("\x1b");
    expect(rawBytes("Up", NO_MODS)).toBe("\x1b[A");
    expect(rawBytes("NPage", NO_MODS)).toBe("\x1b[6~");
    expect(rawBytes("x", alt)).toBe("\x1bx");
    expect(rawBytes("|", NO_MODS)).toBe("|");
  });
});
