import { describe, expect, it } from "vitest";

import { findAll } from "./find";

describe("findAll", () => {
  it("ignores case", () => {
    expect(findAll("Error: error ERROR", "error")).toEqual([
      [0, 5],
      [7, 12],
      [13, 18],
    ]);
  });

  it("takes the query literally", () => {
    expect(findAll("a.b axb (x) [y] $1 \\n", "a.b")).toEqual([[0, 3]]);
    expect(findAll("call(x) [y] $1 \\n", "(x)")).toEqual([[4, 7]]);
    expect(findAll("[y] $1 \\n", "[y]")).toEqual([[0, 3]]);
    expect(findAll("cost $1 here", "$1")).toEqual([[5, 7]]);
    expect(findAll("a \\n b", "\\n")).toEqual([[2, 4]]);
  });

  it("counts offsets in the original text", () => {
    // "İ" lowercases to two code units; offsets must still point into the original.
    const text = "İstanbul and istanbul";
    expect(findAll(text, "and")).toEqual([[9, 12]]);
    expect(findAll("⏺ Done ⏺ done", "done")).toEqual([
      [2, 6],
      [9, 13],
    ]);
  });

  it("finds nothing for an empty query", () => {
    expect(findAll("anything", "")).toEqual([]);
  });
});
