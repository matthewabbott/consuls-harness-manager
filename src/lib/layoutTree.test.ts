import { describe, expect, it } from "vitest";

import {
  type LayoutNode,
  MAX_LEAVES,
  besideEdge,
  edgeAt,
  equalize,
  insert,
  leafNode,
  leafOf,
  leaves,
  rects,
  remove,
  renameTarget,
  sanitize,
  setSizes,
} from "./layoutTree";

const t = (n: string) => `pane:h#${n}`;
const L = (n: string) => leafNode(t(n), n);
/** The tree as a compact string: row(a,col(b,c)). */
const shape = (n: LayoutNode | null): string =>
  !n ? "-" : n.kind === "leaf" ? n.id : `${n.dir}(${n.children.map(shape).join(",")})`;

describe("layout tree", () => {
  it("builds the arrangements by splitting at edges", () => {
    let root: LayoutNode | null = insert(null, null, "center", L("a"));
    root = insert(root, "a", "right", L("b"));
    expect(shape(root)).toBe("row(a,b)");
    root = insert(root, "a", "bottom", L("c"));
    root = insert(root, "b", "bottom", L("d"));
    expect(shape(root)).toBe("row(col(a,c),col(b,d))");
    // Big top, skinny side bar, wide console under both.
    let console: LayoutNode | null = insert(insert(L("big"), "big", "right", L("side")), null, "bottom", L("con"));
    expect(shape(console)).toBe("col(row(big,side),con)");
    console = setSizes(console, (console as { id: string }).id, [3, 1]);
    expect(rects(console).leaves.find((l) => l.id === "con")!.rect).toEqual({ x: 0, y: 0.75, w: 1, h: 0.25 });
  });

  it("splits a leaf's share, merging into a split of the same direction", () => {
    const root = insert(insert(L("a"), "a", "right", L("b")), "b", "right", L("c"));
    expect(shape(root)).toBe("row(a,b,c)");
    expect(root.kind === "split" && root.sizes).toEqual([0.5, 0.25, 0.25]);
    expect(shape(insert(root, "a", "left", L("z")))).toBe("row(z,a,b,c)");
  });

  it("removes a leaf, giving its space back and collapsing splits", () => {
    const root = insert(insert(L("a"), "a", "right", L("b")), "b", "bottom", L("c"));
    expect(shape(remove(root, "c"))).toBe("row(a,b)");
    const twoLeft = remove(root, "b")!;
    expect(shape(twoLeft)).toBe("row(a,c)");
    expect(twoLeft.kind === "split" && twoLeft.sizes).toEqual([0.5, 0.5]);
    expect(remove(L("a"), "a")).toBeNull();
  });

  it("replaces a target at the center, and renames targets", () => {
    const root = insert(L("a"), "a", "center", leafNode(t("x")));
    expect(leaves(root).map((l) => l.target)).toEqual([t("x")]);
    const renamed = renameTarget(insert(L("a"), "a", "right", L("b")), t("b"), t("B"));
    expect(leafOf(renamed, t("B"))?.id).toBe("b");
  });

  it("reads back stored trees safely", () => {
    const stored = JSON.parse(JSON.stringify(insert(insert(L("a"), "a", "right", L("b")), "a", "bottom", L("c"))));
    expect(shape(sanitize(stored))).toBe("row(col(a,c),b)");
    // Empty leaves, duplicates and junk go; one child left means no split.
    const junk = { kind: "split", id: "s", dir: "row", sizes: [1, 1, 1], children: [{ kind: "leaf", id: "a", target: t("a") }, { kind: "leaf", id: "b", target: null }, { kind: "leaf", id: "c", target: t("a") }, 7] };
    expect(shape(sanitize(junk))).toBe("a");
    expect(sanitize(null)).toBeNull();
    const many = { kind: "split", id: "s", dir: "row", sizes: [], children: "abcdef".split("").map((n) => ({ kind: "leaf", id: n, target: t(n) })) };
    expect(leaves(sanitize(many))).toHaveLength(MAX_LEAVES);
  });

  it("lays out leaves and dividers", () => {
    const root = equalize(insert(insert(L("a"), "a", "right", L("b")), "b", "bottom", L("c")));
    const r = rects(root);
    expect(r.leaves.map((l) => [l.id, l.rect])).toEqual([
      ["a", { x: 0, y: 0, w: 0.5, h: 1 }],
      ["b", { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
      ["c", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
    ]);
    expect(r.dividers.map((d) => [d.dir, d.at])).toEqual([
      ["row", { x: 0.5, y: 0, w: 0, h: 1 }],
      ["col", { x: 0.5, y: 0.5, w: 0.5, h: 0 }],
    ]);
  });

  it("finds the edge under the pointer", () => {
    const box = { left: 100, top: 100, width: 400, height: 200 };
    expect(edgeAt(box, 120, 200)).toBe("left");
    expect(edgeAt(box, 480, 200)).toBe("right");
    expect(edgeAt(box, 300, 110)).toBe("top");
    expect(edgeAt(box, 300, 290)).toBe("bottom");
    expect(edgeAt(box, 300, 200)).toBe("center");
    expect(besideEdge({ width: 900, height: 500 })).toBe("right");
    expect(besideEdge({ width: 500, height: 600 })).toBe("bottom");
  });
});
