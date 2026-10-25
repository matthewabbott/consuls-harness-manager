import { describe, expect, it } from "vitest";

import { dropGap, movesIt, moveToGap } from "./reorder";

const rows = [
  { top: 0, bottom: 20 },
  { top: 22, bottom: 42 },
  { top: 44, bottom: 64 },
];

describe("dropGap", () => {
  it("picks the gap by the rows' middles", () => {
    expect(dropGap(-5, rows)).toBe(0);
    expect(dropGap(9, rows)).toBe(0);
    expect(dropGap(11, rows)).toBe(1);
    expect(dropGap(40, rows)).toBe(2);
    expect(dropGap(60, rows)).toBe(3);
    expect(dropGap(500, rows)).toBe(3);
    expect(dropGap(5, [])).toBe(0);
  });
});

describe("moveToGap", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves up and down", () => {
    expect(moveToGap(ids, "c", 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveToGap(ids, "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(moveToGap(ids, "a", 2)).toEqual(["b", "a", "c", "d"]);
    expect(moveToGap(ids, "d", 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("leaves the list alone for the gaps beside the item, or an unknown item", () => {
    expect(moveToGap(ids, "b", 1)).toEqual(ids);
    expect(moveToGap(ids, "b", 2)).toEqual(ids);
    expect(moveToGap(ids, "x", 0)).toBe(ids);
    expect(movesIt(ids, "b", 1)).toBe(false);
    expect(movesIt(ids, "b", 2)).toBe(false);
    expect(movesIt(ids, "b", 0)).toBe(true);
    expect(movesIt(ids, "b", 3)).toBe(true);
    expect(movesIt(ids, "x", 0)).toBe(false);
  });
});
