// Split layouts: a window shows up to four things at once (panes and open files), arranged as a
// tree of rows and columns. Two columns are `row[a, b]`, a 2×2 grid `row[col[a, c], col[b, d]]`,
// a big pane with a side bar over a console `col[row[big, side], console]`. Pure functions; the
// store (`store/layout.ts`) keeps one tree per window.

/** What a leaf shows: `pane:<paneIdentity>` or `file:<host>\n<path>` (`fileId`). */
export type Target = string;

export interface Leaf {
  kind: "leaf";
  id: string;
  /** null: an empty leaf waiting for something to be picked (never saved). */
  target: Target | null;
}

export interface Split {
  kind: "split";
  id: string;
  /** row: children side by side; col: stacked. */
  dir: "row" | "col";
  /** Each child's share, summing to 1. */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = Leaf | Split;
export type Edge = "left" | "right" | "top" | "bottom" | "center";

export const MAX_LEAVES = 4;

export const paneTarget = (identity: string): Target => `pane:${identity}`;
export const fileTarget = (fileId: string): Target => `file:${fileId}`;

export function parseTarget(t: Target): { pane: string } | { file: string } | null {
  if (t.startsWith("pane:")) return { pane: t.slice(5) };
  if (t.startsWith("file:")) return { file: t.slice(5) };
  return null;
}

let seq = 0;
export const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

export const leafNode = (target: Target | null, id = newId()): Leaf => ({ kind: "leaf", id, target });

export function leaves(root: LayoutNode | null): Leaf[] {
  if (!root) return [];
  return root.kind === "leaf" ? [root] : root.children.flatMap(leaves);
}

export const findLeaf = (root: LayoutNode | null, id: string | null) => leaves(root).find((l) => l.id === id);
export const leafOf = (root: LayoutNode | null, target: Target) => leaves(root).find((l) => l.target === target);

function map(node: LayoutNode, f: (n: LayoutNode) => LayoutNode): LayoutNode {
  const n = node.kind === "split" ? { ...node, children: node.children.map((c) => map(c, f)) } : node;
  return f(n);
}

const normal = (sizes: number[]) => {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
};

/** Splits with one child become that child; a split inside a split of the same direction merges into it. */
function tidy(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const t = tidy(c);
    if (t.kind === "split" && t.dir === node.dir) {
      t.children.forEach((cc, j) => {
        children.push(cc);
        sizes.push(node.sizes[i] * t.sizes[j]);
      });
    } else {
      children.push(t);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normal(sizes) };
}

/**
 * `leaf` placed at `edge` of the leaf `at` (null: of the whole tree). The center replaces what
 * `at` shows. The new leaf takes half of the space it splits.
 */
export function insert(root: LayoutNode | null, at: string | null, edge: Edge, leaf: Leaf): LayoutNode {
  if (!root) return leaf;
  if (edge === "center") return at === null ? leaf : retarget(root, at, leaf.target);
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const wrap = (n: LayoutNode): Split => ({
    kind: "split",
    id: newId(),
    dir,
    sizes: [0.5, 0.5],
    children: before ? [leaf, n] : [n, leaf],
  });
  if (at === null) return tidy(wrap(root));
  return tidy(map(root, (n) => (n.kind === "leaf" && n.id === at ? wrap(n) : n)));
}

/** The tree without leaf `id` (null when it was the last one); its space goes to its siblings. */
export function remove(root: LayoutNode | null, id: string): LayoutNode | null {
  if (!root) return null;
  if (root.kind === "leaf") return root.id === id ? null : root;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((c, i) => {
    const r = remove(c, id);
    if (r) {
      children.push(r);
      sizes.push(root.sizes[i]);
    }
  });
  if (!children.length) return null;
  return tidy({ ...root, children, sizes: normal(sizes) });
}

export function retarget(root: LayoutNode, id: string, target: Target | null): LayoutNode {
  return map(root, (n) => (n.kind === "leaf" && n.id === id ? { ...n, target } : n));
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  return map(root, (n) => (n.kind === "split" && n.id === splitId && n.children.length === sizes.length ? { ...n, sizes: normal(sizes) } : n));
}

/** Every split's children made equal. */
export function equalize(root: LayoutNode): LayoutNode {
  return map(root, (n) => (n.kind === "split" ? { ...n, sizes: n.children.map(() => 1 / n.children.length) } : n));
}

export function renameTarget(root: LayoutNode, from: Target, to: Target): LayoutNode {
  return map(root, (n) => (n.kind === "leaf" && n.target === from ? { ...n, target: to } : n));
}

/**
 * A tree read back from storage, made safe: unknown shapes and empty leaves dropped, each target
 * once, at most `MAX_LEAVES` leaves, sizes summing to 1.
 */
export function sanitize(raw: unknown): LayoutNode | null {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const walk = (v: unknown): LayoutNode | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const id = typeof o.id === "string" && !ids.has(o.id) ? o.id : newId();
    ids.add(id);
    if (o.kind === "leaf") {
      if (typeof o.target !== "string" || !parseTarget(o.target) || seen.has(o.target) || seen.size >= MAX_LEAVES) return null;
      seen.add(o.target);
      return { kind: "leaf", id, target: o.target };
    }
    if (o.kind !== "split" || (o.dir !== "row" && o.dir !== "col") || !Array.isArray(o.children)) return null;
    const sizes = Array.isArray(o.sizes) ? o.sizes : [];
    const children: LayoutNode[] = [];
    const kept: number[] = [];
    o.children.forEach((c, i) => {
      const n = walk(c);
      if (!n) return;
      children.push(n);
      const s = sizes[i];
      kept.push(typeof s === "number" && s > 0 && Number.isFinite(s) ? s : 1);
    });
    if (!children.length) return null;
    return tidy({ kind: "split", id, dir: o.dir, sizes: normal(kept), children });
  };
  return walk(raw);
}

/** A rectangle as fractions of the layout's area. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  splitId: string;
  /** Between child `index` and `index + 1`. */
  index: number;
  dir: "row" | "col";
  /** Where the divider sits (a line: w or h is 0), and the split's whole area. */
  at: Rect;
  area: Rect;
}

/** Where each leaf and each divider goes. */
export function rects(root: LayoutNode | null): { leaves: { id: string; rect: Rect }[]; dividers: Divider[] } {
  const out = { leaves: [] as { id: string; rect: Rect }[], dividers: [] as Divider[] };
  const walk = (n: LayoutNode, r: Rect) => {
    if (n.kind === "leaf") return void out.leaves.push({ id: n.id, rect: r });
    let offset = 0;
    n.children.forEach((c, i) => {
      const share = n.sizes[i];
      const cr =
        n.dir === "row" ? { x: r.x + offset * r.w, y: r.y, w: share * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: share * r.h };
      walk(c, cr);
      offset += share;
      if (i < n.children.length - 1) {
        const at = n.dir === "row" ? { x: r.x + offset * r.w, y: r.y, w: 0, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: 0 };
        out.dividers.push({ splitId: n.id, index: i, dir: n.dir, at, area: r });
      }
    });
  };
  if (root) walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

/** Which edge of a box (in pixels) a point is over: the outer quarter on each side, else the center. */
export function edgeAt(box: { left: number; top: number; width: number; height: number }, x: number, y: number): Edge {
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const [edge, dist] = (Object.entries(d) as [Edge, number][]).reduce((a, b) => (b[1] < a[1] ? b : a));
  return dist < 0.25 ? edge : "center";
}

/** The side to open something next to a box: beside it when it's wide, below it when it's tall. */
export const besideEdge = (box: { width: number; height: number }): Edge => (box.width >= box.height * 1.2 ? "right" : "bottom");
