import { describe, expect, it } from "vitest";

import { inOrder, nextColor, resolveLabels, LABEL_COLORS } from "./labels";

const defs = [
  { id: "work", name: "Work", color: "#111" },
  { id: "home", name: "Home", color: "#222" },
  { id: "urgent", name: "Urgent", color: "#333" },
];

describe("resolveLabels", () => {
  it("follows the labels' order, unknown ids last", () => {
    expect(resolveLabels(["urgent", "gone", "work"], defs).map((l) => [l.id, l.unknown ?? false])).toEqual([
      ["work", false],
      ["urgent", false],
      ["gone", true],
    ]);
    expect(resolveLabels([], defs)).toEqual([]);
  });
});

describe("inOrder", () => {
  it("puts listed labels first, the rest after in their order", () => {
    expect(inOrder(defs, ["urgent", "work"]).map((l) => l.id)).toEqual(["urgent", "work", "home"]);
    expect(inOrder(defs, []).map((l) => l.id)).toEqual(["work", "home", "urgent"]);
    expect(inOrder(defs, ["nope", "home"]).map((l) => l.id)).toEqual(["home", "work", "urgent"]);
  });
});

describe("nextColor", () => {
  it("picks an unused colour", () => {
    expect(nextColor([])).toBe(LABEL_COLORS[0]);
    expect(nextColor([{ id: "a", name: "a", color: LABEL_COLORS[0] }])).toBe(LABEL_COLORS[1]);
  });
});
