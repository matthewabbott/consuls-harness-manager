// The desktop window's layout: the grid, or up to four panes and files side by side (a split
// tree, `lib/layoutTree.ts`). Kept per window (`consuls.layout.<window>.v1`). Opening something
// follows one rule (`show`): if it's on screen, focus it; from the grid, show it alone (a split
// it replaces can be restored); otherwise it takes the focused split's place. Files opened from
// a terminal go beside it (`openFileBeside`).
//
// `useApp.expanded` stays what the rest of the app reads: here it mirrors the pane the composer
// types into (the focused pane split), and `setExpanded` goes through `show` (`startLayout`).

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import {
  type Edge,
  type LayoutNode,
  type Target,
  MAX_LEAVES,
  besideEdge,
  fileTarget,
  findLeaf,
  insert,
  leafNode,
  leafOf,
  leaves,
  parseTarget,
  paneTarget,
  remove,
  renameTarget,
  retarget,
  sanitize,
  setSizes,
} from "../lib/layoutTree";
import { paneIdentity } from "../lib/panes";
import { uiStorage } from "../lib/uiState";
import { onIdentityChange, setPaneShower, useApp } from "./app";
import { setFileShower, useEditor } from "./editor";
import { useUi } from "./ui";

interface LayoutState {
  root: LayoutNode | null;
  /** The focused leaf. */
  focused: string | null;
  /** The grid shows instead (the layout stays, to come back to). */
  grid: boolean;
  /** A split that showing something alone replaced ("Restore split"). */
  previous: LayoutNode | null;
  /** A leaf shown over the others (they keep their places, hidden). */
  zoomed: string | null;
  /** Leaves by when they were last focused, latest first. */
  recent: string[];
  /** Bumped when focus should move into the focused leaf (not just follow a click). */
  focusSeq: number;

  show(target: Target): void;
  /** `target` beside `from` (a leaf), or `at` an edge of the layout (from: null). */
  place(from: string | null, edge: Edge, target: Target | null): void;
  focus(id: string, move?: boolean): void;
  fill(id: string, target: Target): void;
  close(id: string): void;
  setSizes(splitId: string, sizes: number[]): void;
  zoom(id: string | null): void;
  toGrid(): void;
  toLayout(): void;
  restorePrevious(): void;
  openFileBeside(origin: Target | null, file: Target): void;
}

/** Where focus went: the leaf first, then the rest as they were. */
const bump = (recent: string[], id: string) => [id, ...recent.filter((r) => r !== id)];

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => ({
      root: null,
      focused: null,
      grid: true,
      previous: null,
      zoomed: null,
      recent: [],
      focusSeq: 0,

      show: (target) => {
        const s = get();
        const there = leafOf(s.root, target);
        if (there) {
          set({ grid: false, focused: there.id, zoomed: s.zoomed === there.id ? s.zoomed : null, recent: bump(s.recent, there.id), focusSeq: s.focusSeq + 1 });
          return;
        }
        if (s.grid || !s.root) {
          const leaf = leafNode(target);
          const keep = s.root && leaves(s.root).length > 1 ? s.root : s.previous;
          set({ root: leaf, focused: leaf.id, grid: false, previous: keep, zoomed: null, recent: [leaf.id], focusSeq: s.focusSeq + 1 });
          return;
        }
        const at = findLeaf(s.root, s.focused) ?? leaves(s.root)[0];
        set({ root: retarget(s.root, at.id, target), focused: at.id, recent: bump(s.recent, at.id), focusSeq: s.focusSeq + 1 });
      },

      place: (from, edge, target) => {
        const s = get();
        let root = s.root;
        if (target) {
          // Already on screen: it moves.
          const there = leafOf(root, target);
          if (there && (edge === "center" || there.id === from)) return get().focus(there.id, true);
          if (there) root = remove(root, there.id);
        }
        if (leaves(root).length >= MAX_LEAVES && edge !== "center") return;
        const leaf = leafNode(target);
        root = insert(root, findLeaf(root, from) ? from : null, edge, leaf);
        const focused = edge === "center" && from ? from : leaf.id;
        set({ root, focused, grid: false, zoomed: null, recent: bump(s.recent, focused), focusSeq: s.focusSeq + 1 });
      },

      focus: (id, move = false) => {
        const s = get();
        if (s.focused === id && !move) return;
        set({ focused: id, recent: bump(s.recent, id), focusSeq: move ? s.focusSeq + 1 : s.focusSeq });
      },

      fill: (id, target) => {
        const s = get();
        if (!s.root) return;
        const there = leafOf(s.root, target);
        const root = there && there.id !== id ? remove(s.root, there.id) : s.root;
        if (!root) return;
        set({ root: retarget(root, id, target), focused: id, recent: bump(s.recent, id), focusSeq: s.focusSeq + 1 });
      },

      close: (id) => {
        const s = get();
        const root = remove(s.root, id);
        const recent = s.recent.filter((r) => r !== id);
        const focused = s.focused === id ? (recent.find((r) => findLeaf(root, r)) ?? leaves(root)[0]?.id ?? null) : s.focused;
        set({ root, focused, recent, zoomed: s.zoomed === id ? null : s.zoomed, grid: root ? s.grid : true, focusSeq: s.focusSeq + 1 });
      },

      setSizes: (splitId, sizes) => {
        const root = get().root;
        if (root) set({ root: setSizes(root, splitId, sizes) });
      },

      zoom: (id) => set({ zoomed: id }),
      toGrid: () => set({ grid: true, zoomed: null }),
      toLayout: () => {
        if (get().root) set((s) => ({ grid: false, focusSeq: s.focusSeq + 1 }));
      },
      restorePrevious: () => {
        const s = get();
        if (!s.previous) return;
        const first = leaves(s.previous)[0];
        set({ root: s.previous, previous: null, grid: false, zoomed: null, focused: first?.id ?? null, recent: first ? [first.id] : [], focusSeq: s.focusSeq + 1 });
      },

      openFileBeside: (origin, file) => {
        const s = get();
        if (s.grid || !s.root) return get().show(file);
        const there = leafOf(s.root, file);
        if (there) return get().focus(there.id, true);
        const files = leaves(s.root).filter((l) => l.target?.startsWith("file:"));
        const lastFile = s.recent.map((id) => files.find((f) => f.id === id)).find(Boolean) ?? files[0];
        if (lastFile) return get().fill(lastFile.id, file);
        const source = (origin && leafOf(s.root, origin)) || findLeaf(s.root, s.focused) || leaves(s.root)[0];
        if (leaves(s.root).length < MAX_LEAVES) {
          const box = document.querySelector<HTMLElement>(`[data-leaf="${source.id}"]`)?.getBoundingClientRect() ?? { width: 1, height: 1 };
          return get().place(source.id, besideEdge(box), file);
        }
        const oldest = [...s.recent].reverse().find((id) => id !== source.id && findLeaf(s.root, id)) ?? leaves(s.root).find((l) => l.id !== source.id)?.id;
        if (oldest) get().fill(oldest, file);
      },
    }),
    {
      // Renamed per window by `startLayout` before it's loaded.
      name: "consuls.layout.main.v1",
      storage: createJSONStorage(() => uiStorage),
      skipHydration: true,
      partialize: ({ root, focused, grid, previous }) => ({ root, focused, grid, previous }),
      merge: (stored, current) => {
        const s = (stored ?? {}) as Partial<LayoutState>;
        const root = sanitize(s.root);
        return {
          ...current,
          root,
          previous: sanitize(s.previous),
          grid: !root || s.grid !== false,
          focused: findLeaf(root, s.focused ?? null)?.id ?? leaves(root)[0]?.id ?? null,
        };
      },
    },
  ),
);

/** Whether leaf `id` is maximized: shown over the others, or (alone) with the side panels hidden. */
export const isZoomed = (s: Pick<LayoutState, "root" | "zoomed">, id: string, maximized: boolean) =>
  s.zoomed === id || (maximized && leaves(s.root).length === 1);

/** Maximizes leaf `id` (side panels hidden too), or restores it. */
export function toggleZoom(id: string) {
  const on = isZoomed(useLayout.getState(), id, useUi.getState().maximized);
  useLayout.getState().zoom(on ? null : id);
  useUi.getState().setMaximized(!on);
}

const allPanes = () => Object.values(useApp.getState().panes).flat();

export function paneOf(target: Target | null | undefined, panes: PaneInfo[] = allPanes()): PaneInfo | undefined {
  const t = target ? parseTarget(target) : null;
  return t && "pane" in t ? panes.find((p) => paneIdentity(p) === t.pane) : undefined;
}

export const fileOf = (target: Target | null | undefined): string | undefined => {
  const t = target ? parseTarget(target) : null;
  return t && "file" in t ? t.file : undefined;
};

/** The pane the composer types into: the focused split's, else the pane split focused last. */
export function composerTarget(s: LayoutState, panes: PaneInfo[] = allPanes()): PaneInfo | undefined {
  if (s.grid || !s.root) return undefined;
  for (const id of [s.focused, ...s.recent]) {
    const p = paneOf(findLeaf(s.root, id)?.target, panes);
    if (p) return p;
  }
  return undefined;
}

/** Panes on screen (other than a zoomed split's hidden neighbours). */
export function visiblePanes(s: LayoutState, panes: PaneInfo[] = allPanes()): PaneInfo[] {
  if (s.grid || !s.root) return [];
  return leaves(s.root)
    .filter((l) => !s.zoomed || l.id === s.zoomed)
    .map((l) => paneOf(l.target, panes))
    .filter((p): p is PaneInfo => !!p);
}

/**
 * Hooks the layout into the app (desktop): loads this window's layout, routes `setExpanded` and
 * opened files through it, mirrors `expanded`, follows panes gaining identities, and drops
 * splits whose pane went away or whose file was closed.
 */
export async function startLayout(windowLabel: string) {
  useLayout.persist.setOptions({ name: `consuls.layout.${windowLabel}.v1` });
  await useLayout.persist.rehydrate();

  setPaneShower((key) => {
    const s = useLayout.getState();
    if (key === null) {
      // Leaving the pane being worked in: its split goes, or the grid shows when it was the only one.
      const p = composerTarget(s);
      const leaf = p && leafOf(s.root, paneTarget(paneIdentity(p)));
      if (leaf && leaves(s.root).length > 1) s.close(leaf.id);
      else s.toGrid();
      return;
    }
    const pane = allPanes().find((p) => p.key === key);
    if (pane) s.show(paneTarget(paneIdentity(pane)));
  });
  setFileShower((id, origin) => {
    const pane = origin === null ? undefined : allPanes().find((p) => p.key === origin);
    useLayout.getState().openFileBeside(pane ? paneTarget(paneIdentity(pane)) : null, fileTarget(id));
  });
  onIdentityChange((from, to) => {
    const root = useLayout.getState().root;
    if (root) useLayout.setState({ root: renameTarget(root, paneTarget(from), paneTarget(to)) });
  });

  // Files the layout shows, open again (open files aren't kept across restarts).
  for (const l of leaves(useLayout.getState().root)) {
    const id = fileOf(l.target);
    if (id && !useEditor.getState().files[id]) {
      const [host, path] = id.split("\n");
      void useEditor.getState().open(host, path, null, undefined, false);
    }
  }

  const seen = new Set<Target>();
  const sync = () => {
    const s = useLayout.getState();
    const panes = allPanes();
    // A pane seen in this session and gone since (closed, or hidden) takes its split with it;
    // one not seen yet may still be connecting.
    for (const l of leaves(s.root)) {
      if (!l.target?.startsWith("pane:")) continue;
      const p = paneOf(l.target, panes);
      if (p && !p.hidden) seen.add(l.target);
      else if (seen.has(l.target)) {
        seen.delete(l.target);
        useLayout.getState().close(l.id);
      }
    }
    const expanded = composerTarget(useLayout.getState(), panes)?.key ?? null;
    if (useApp.getState().expanded !== expanded) useApp.setState({ expanded });
  };
  useApp.subscribe((s, prev) => {
    if (s.panes !== prev.panes) sync();
  });
  useLayout.subscribe(sync);
  useEditor.subscribe((s, prev) => {
    if (s.files === prev.files) return;
    for (const l of leaves(useLayout.getState().root)) {
      const id = fileOf(l.target);
      if (id && prev.files[id] && !s.files[id]) useLayout.getState().close(l.id);
    }
  });
  sync();
}
