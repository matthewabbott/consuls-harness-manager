import { describe, expect, it } from "vitest";

import { canBack, canForward, emptyHistory, pushHistory, replaceCurrent, stepHistory } from "./history";

const same = (a: string, b: string) => a === b;

describe("navigation history", () => {
  it("goes back and forward like a browser", () => {
    let h = emptyHistory<string>();
    for (const p of ["C:/Users/u", "D:/", "D:/a"]) h = pushHistory(h, p, same);
    expect(canBack(h)).toBe(true);
    expect(canForward(h)).toBe(false);

    const back = stepHistory(h, -1)!;
    expect(back.entry).toBe("D:/");
    h = back.history;
    expect(canForward(h)).toBe(true);
    expect(stepHistory(h, 1)!.entry).toBe("D:/a");

    // A new visit drops the forward entries.
    h = pushHistory(h, "C:/", same);
    expect(h.entries).toEqual(["C:/Users/u", "D:/", "C:/"]);
    expect(canForward(h)).toBe(false);
    expect(stepHistory(h, 1)).toBe(null);
  });

  it("ignores revisiting the current entry and renames it in place", () => {
    let h = pushHistory(emptyHistory<string>(), "~", same);
    h = pushHistory(h, "~", same);
    expect(h.entries).toEqual(["~"]);
    h = replaceCurrent(h, "/home/u");
    expect(h).toEqual({ entries: ["/home/u"], index: 0 });
    expect(stepHistory(h, -1)).toBe(null);
  });

  it("keeps the last 50 entries", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 60; i++) h = pushHistory(h, i, (a, b) => a === b);
    expect(h.entries.length).toBe(50);
    expect(h.entries[0]).toBe(10);
    expect(h.index).toBe(49);
  });
});
