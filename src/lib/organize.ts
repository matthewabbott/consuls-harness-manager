// Grouping and sorting of panes in the grid.

import type { LabelDef } from "../ipc/bindings/LabelDef";
import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";

export type GroupBy = "machine" | "label" | "project" | "status" | "none";
export type SortBy = "attention" | "name" | "recent";

export interface Group {
  id: string;
  title: string;
  color?: string;
  panes: PaneInfo[];
}

/** Status rank for "attention first": unseen needs-input, unseen done, seen waiting, working, rest. */
export function attentionRank(a: PaneAttention | undefined): number {
  if (!a) return 5;
  if (a.attention === "unacked") return a.activity === "needsInput" ? 0 : 1;
  if (a.attention === "acked") return 2;
  if (a.activity === "working") return 3;
  return 4;
}

export function sortPanes(
  panes: PaneInfo[],
  by: SortBy,
  title: (p: PaneInfo) => string,
  attention: Record<number, PaneAttention>,
  lastOpened: Record<string, number>,
  identity: (p: PaneInfo) => string,
): PaneInfo[] {
  const byName = (a: PaneInfo, b: PaneInfo) => title(a).localeCompare(title(b), undefined, { sensitivity: "base" }) || a.key - b.key;
  const list = [...panes];
  if (by === "name") return list.sort(byName);
  if (by === "recent") return list.sort((a, b) => (lastOpened[identity(b)] ?? 0) - (lastOpened[identity(a)] ?? 0) || byName(a, b));
  return list.sort((a, b) => attentionRank(attention[a.key]) - attentionRank(attention[b.key]) || byName(a, b));
}

function projectOf(p: PaneInfo): string {
  const parts = p.currentPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

/**
 * Groups panes (machine grouping is rendered by the grid itself, with host status). With
 * label grouping a pane appears once per label it has — tags, not folders.
 */
export function groupPanes(panes: PaneInfo[], by: Exclude<GroupBy, "machine">, labels: LabelDef[], attention: Record<number, PaneAttention>): Group[] {
  if (by === "none") return [{ id: "all", title: "All panes", panes }];
  if (by === "label") {
    const groups: Group[] = labels.map((l) => ({ id: `label:${l.id}`, title: l.name, color: l.color, panes: panes.filter((p) => p.labels.includes(l.id)) }));
    const known = new Set(labels.map((l) => l.id));
    const unlabeled = panes.filter((p) => !p.labels.some((l) => known.has(l)));
    if (unlabeled.length) groups.push({ id: "label:none", title: "Unlabeled", panes: unlabeled });
    return groups.filter((g) => g.panes.length > 0);
  }
  if (by === "project") {
    const map = new Map<string, PaneInfo[]>();
    for (const p of panes) {
      const k = projectOf(p);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, ps]) => ({ id: `project:${k}`, title: k, panes: ps }));
  }
  const rank = (p: PaneInfo) => attentionRank(attention[p.key]);
  const buckets: [string, string, (p: PaneInfo) => boolean][] = [
    ["needs", "Needs you", (p) => rank(p) <= 2],
    ["working", "Working", (p) => rank(p) === 3],
    ["other", "Everything else", (p) => rank(p) >= 4],
  ];
  return buckets.map(([id, title, f]) => ({ id: `status:${id}`, title, panes: panes.filter(f) })).filter((g) => g.panes.length > 0);
}
