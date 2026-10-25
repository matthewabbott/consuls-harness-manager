import { describe, expect, it } from "vitest";

import { MouseModes, WheelSteps, wheelReport } from "./mouse";

describe("MouseModes", () => {
  it("follows tracking and encoding like tmux and xterm", () => {
    const m = new MouseModes();
    expect(m.apply([1000], true)).toBe(true);
    expect(m.apply([1002], true)).toBe(true);
    expect(m.apply([1006], true)).toBe(true);
    expect([m.tracking, m.sgr]).toEqual([1002, true]);
    // Resetting any tracking mode ends tracking; the encoding stays.
    m.apply([1000], false);
    expect([m.tracking, m.sgr]).toEqual([0, true]);
    // ncurses sets both at once; a mix with other modes isn't all-mouse.
    expect(m.apply([1006, 1000], true)).toBe(true);
    expect(m.apply([1049, 1003], true)).toBe(false);
    expect(m.tracking).toBe(1003);
    expect(m.apply([1004], true)).toBe(false);
    m.reset();
    expect([m.tracking, m.sgr, m.utf8]).toEqual([0, false, false]);
  });
});

describe("wheelReport", () => {
  const modes = (tracking: 0 | 1000, sgr = false, utf8 = false) => Object.assign(new MouseModes(), { tracking, sgr, utf8 });

  it("encodes as the program asked", () => {
    expect(wheelReport(modes(0, true), true, 0, 0)).toBeNull();
    expect(wheelReport(modes(1000, true), true, 9, 4)).toEqual({ data: "\x1b[<64;10;5M", binary: false });
    expect(wheelReport(modes(1000, true), false, 9, 4, { shiftKey: false, altKey: true, ctrlKey: false })).toEqual({ data: "\x1b[<73;10;5M", binary: false });
    expect(wheelReport(modes(1000), true, 137, 4)).toEqual({ data: "\x1b[M`\xaa%", binary: true });
    expect(wheelReport(modes(1000), false, 230, 4)).toBeNull();
    expect(wheelReport(modes(1000, false, true), true, 230, 4)).toEqual({ data: "\x1b[M`ć%", binary: false });
  });
});

describe("WheelSteps", () => {
  it("counts a trackpad's small steps into lines", () => {
    const w = new WheelSteps();
    const steps = Array.from({ length: 12 }, () => w.lines({ deltaY: -10, deltaMode: 0 }, 15, 24));
    expect(steps.reduce((a, b) => a + b, 0)).toBe(-2); // 120 px × 0.3 / 15 px
    expect(w.lines({ deltaY: 3, deltaMode: 1 }, 15, 24)).toBe(3);
    expect(w.lines({ deltaY: 0, deltaMode: 0 }, 15, 24)).toBe(0);
  });

  it("pages every half screen, starting over when turned around", () => {
    const w = new WheelSteps();
    expect(w.pages({ deltaY: -100, deltaMode: 0 }, 10, 24)).toBe(0);
    expect(w.pages({ deltaY: -100, deltaMode: 0 }, 10, 24)).toBe(-1); // 20 rows: one half screen
    expect(w.pages({ deltaY: 30, deltaMode: 0 }, 10, 24)).toBe(0);
    expect(w.pages({ deltaY: 100, deltaMode: 0 }, 10, 24)).toBe(1);
    expect(w.pages({ deltaY: 1, deltaMode: 2 }, 10, 24)).toBe(2);
  });
});
