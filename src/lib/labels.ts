import type { LabelDef } from "../ipc/bindings/LabelDef";

export const LABEL_COLORS = ["#f5a25d", "#a192ff", "#6aa9ff", "#4ade9a", "#ff6b81", "#f2c14e", "#5fd4c8", "#8a93ad"];

/** Resolves a pane's label ids to definitions, in the labels' order; unknown ids (e.g. deleted
 * on another device) come last as muted placeholders, so they can still be seen and removed. */
export function resolveLabels(ids: string[], defs: LabelDef[]): (LabelDef & { unknown?: boolean })[] {
  const known = defs.filter((d) => ids.includes(d.id));
  const unknown = ids.filter((id) => !defs.some((d) => d.id === id)).map((id) => ({ id, name: id, color: "#5f6780", unknown: true }));
  return [...known, ...unknown];
}

/** `labels` in the order of `ids` (a reorder the core hasn't confirmed yet); any it doesn't
 * list keep their order after. */
export function inOrder(labels: LabelDef[], ids: string[]): LabelDef[] {
  const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
  return labels.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l.id) - rank(b.l.id) || a.i - b.i).map(({ l }) => l);
}

export function nextColor(defs: LabelDef[]): string {
  const used = new Set(defs.map((d) => d.color));
  return LABEL_COLORS.find((c) => !used.has(c)) ?? LABEL_COLORS[defs.length % LABEL_COLORS.length];
}
