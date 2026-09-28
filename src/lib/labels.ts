import type { LabelDef } from "../ipc/bindings/LabelDef";

export const LABEL_COLORS = ["#f5a25d", "#a192ff", "#6aa9ff", "#4ade9a", "#ff6b81", "#f2c14e", "#5fd4c8", "#8a93ad"];

/** Resolves a pane's label ids to definitions; unknown ids (e.g. deleted on another device)
 * come back as muted placeholders so they can still be seen and removed. */
export function resolveLabels(ids: string[], defs: LabelDef[]): (LabelDef & { unknown?: boolean })[] {
  return ids.map((id) => defs.find((d) => d.id === id) ?? { id, name: id, color: "#5f6780", unknown: true });
}

export function nextColor(defs: LabelDef[]): string {
  const used = new Set(defs.map((d) => d.color));
  return LABEL_COLORS.find((c) => !used.has(c)) ?? LABEL_COLORS[defs.length % LABEL_COLORS.length];
}
