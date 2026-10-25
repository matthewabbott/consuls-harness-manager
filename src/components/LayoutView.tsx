import { useMemo, useRef } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { type Divider, type Rect, leaves, rects } from "../lib/layoutTree";
import { useApp } from "../store/app";
import { useEditor } from "../store/editor";
import { fileOf, paneOf, useLayout } from "../store/layout";
import { useDrag } from "../store/drag";
import { useWindows } from "../store/windows";
import DropHint from "./DropHint";
import FileView from "./FileView";
import PaneLeaf from "./PaneLeaf";
import PickerLeaf from "./PickerLeaf";
import ResizeHandle from "./ResizeHandle";

/** Room between splits (px). */
const GAP = 10;
/** The smallest a split gets by dragging a divider (px). */
const MIN = { x: 260, y: 140 };

const pct = (f: number) => `${f * 100}%`;

/** Where a leaf goes: its share of the area, less half the gap on each inner side. */
function place(r: Rect): React.CSSProperties {
  const inset = (edge: number) => (edge > 0.0001 && edge < 0.9999 ? GAP / 2 : 0);
  return {
    left: `calc(${pct(r.x)} + ${inset(r.x)}px)`,
    top: `calc(${pct(r.y)} + ${inset(r.y)}px)`,
    width: `calc(${pct(r.w)} - ${inset(r.x) + inset(r.x + r.w)}px)`,
    height: `calc(${pct(r.h)} - ${inset(r.y) + inset(r.y + r.h)}px)`,
  };
}

/** A tmux window (two views of one resize it in turn). */
const windowOf = (p: PaneInfo) => (p.tmux ? `${p.host}:${p.tmux.windowId}` : null);

/**
 * The window's splits: each leaf (a pane, a file, or a picker) absolutely placed in its share of
 * the area, all as siblings keyed by leaf id, so changing the tree never remounts a terminal.
 */
export default function LayoutView({ onCompose }: { onCompose(): void }) {
  const root = useLayout((s) => s.root);
  const focused = useLayout((s) => s.focused);
  const zoomed = useLayout((s) => s.zoomed);
  const panes = useApp((s) => s.panes);
  const files = useEditor((s) => s.files);
  const views = useWindows((s) => s.views);
  const drop = useDrag((s) => s.drop);
  const area = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => rects(root), [root]);
  const all = leaves(root);
  const split = all.length > 1;
  const list = useMemo(() => Object.values(panes).flat(), [panes]);

  // Tmux windows shown more than once (here, or in another app window).
  const shownElsewhere = new Set(views.filter((v) => !v.mine).flatMap((v) => v.targets));
  const windows = new Map<string, number>();
  for (const l of all) {
    const p = paneOf(l.target, list);
    const w = p && windowOf(p);
    if (w) windows.set(w, (windows.get(w) ?? 0) + 1);
  }
  const shared = (p: PaneInfo, target: string) => (windowOf(p) !== null && (windows.get(windowOf(p)!) ?? 0) > 1) || shownElsewhere.has(target);

  const drag = (d: Divider) => {
    const node = findSplit(root, d.splitId);
    if (!node) return null;
    const box = area.current?.getBoundingClientRect();
    if (!box) return null;
    const total = d.dir === "row" ? d.area.w * box.width : d.area.h * box.height;
    const pair = node.sizes[d.index] + node.sizes[d.index + 1];
    const min = (d.dir === "row" ? MIN.x : MIN.y) / total;
    return {
      size: node.sizes[d.index] * total,
      onResize: (px: number) => {
        const a = Math.min(pair - min, Math.max(min, px / total));
        const sizes = [...node.sizes];
        sizes[d.index] = a;
        sizes[d.index + 1] = pair - a;
        useLayout.getState().setSizes(node.id, sizes);
      },
    };
  };

  return (
    <div ref={area} className="relative min-h-0 flex-1">
      {layout.leaves.map(({ id, rect }) => {
        const leaf = all.find((l) => l.id === id)!;
        const hidden = zoomed !== null && zoomed !== id;
        const style: React.CSSProperties = zoomed === id ? { inset: 0 } : place(rect);
        const pane = paneOf(leaf.target, list);
        const file = fileOf(leaf.target);
        return (
          <div
            key={id}
            data-leaf={id}
            style={{ ...style, visibility: hidden ? "hidden" : undefined, zIndex: zoomed === id ? 5 : undefined }}
            className="absolute flex min-h-0 min-w-0 flex-col"
            onPointerDownCapture={() => useLayout.getState().focus(id)}
            onFocusCapture={() => useLayout.getState().focus(id)}
          >
            {pane ? (
              <PaneLeaf pane={pane} leafId={id} split={split} focused={focused === id} shared={shared(pane, leaf.target!)} onCompose={onCompose} />
            ) : file && files[file] ? (
              <FileView id={file} leaf={{ id, split, focused: focused === id }} />
            ) : leaf.target === null ? (
              <PickerLeaf leafId={id} />
            ) : (
              <Missing leafId={id} label={file ? "Opening the file…" : "Waiting for this pane (its machine may still be connecting)…"} />
            )}
            {drop?.leaf === id && <DropHint edge={drop.edge} />}
          </div>
        );
      })}
      {zoomed === null &&
        layout.dividers.map((d) => {
          const h = drag(d);
          if (!h) return null;
          const style: React.CSSProperties =
            d.dir === "row"
              ? { left: `calc(${pct(d.at.x)} - 4px)`, top: pct(d.at.y), height: pct(d.at.h), width: 8 }
              : { top: `calc(${pct(d.at.y)} - 4px)`, left: pct(d.at.x), width: pct(d.at.w), height: 8 };
          return (
            <div key={`${d.splitId}:${d.index}`} style={style} className={`absolute z-10 flex ${d.dir === "row" ? "justify-center" : "items-center"}`}>
              <ResizeHandle axis={d.dir === "row" ? "x" : "y"} size={h.size} direction={1} onResize={h.onResize} className={d.dir === "col" ? "w-full" : ""} />
            </div>
          );
        })}
    </div>
  );
}

function findSplit(root: ReturnType<typeof useLayout.getState>["root"], id: string) {
  const walk = (n: typeof root): Extract<NonNullable<typeof root>, { kind: "split" }> | null => {
    if (!n || n.kind === "leaf") return null;
    if (n.id === id) return n;
    for (const c of n.children) {
      const f = walk(c);
      if (f) return f;
    }
    return null;
  };
  return walk(root);
}

function Missing({ leafId, label }: { leafId: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-ink-900/60 text-[12.5px] text-mist-500 ring-1 ring-ink-700">
      {label}
      <button onClick={() => useLayout.getState().close(leafId)} className="rounded-lg px-2.5 py-1 text-mist-300 ring-1 ring-ink-600 hover:bg-ink-700">
        Close this split
      </button>
    </div>
  );
}
