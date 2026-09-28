// The Files explorer: which folder it shows (by default, the expanded pane's working
// directory), the lazily loaded tree, and git status for badges.

import { create } from "zustand";

import { backend } from "../ipc/backend";
import type { DirEntryInfo } from "../ipc/bindings/DirEntryInfo";
import type { GitFileStatus } from "../ipc/bindings/GitFileStatus";
import type { GitStatus } from "../ipc/bindings/GitStatus";
import { joinPath } from "../lib/paths";

export interface Root {
  host: string;
  path: string;
}

interface Dir {
  entries: DirEntryInfo[] | null;
  loading: boolean;
  error: string | null;
}

interface FilesState {
  root: Root | null;
  /** Follow the expanded pane's working directory. */
  follow: boolean;
  /** Loaded folders, by absolute path (for the current host). */
  dirs: Record<string, Dir>;
  /** Expanded folders (absolute paths). */
  open: Record<string, true>;
  selected: string | null;
  git: GitStatus | null;
  /** Absolute path → status, including folders (the loudest status inside them). */
  badges: Record<string, GitFileStatus>;

  setRoot(root: Root | null, opts?: { follow?: boolean }): void;
  setFollow(follow: boolean): void;
  load(path: string): Promise<void>;
  toggle(path: string): void;
  collapseAll(): void;
  select(path: string | null): void;
  refresh(): Promise<void>;
  refreshGit(): Promise<void>;
}

const RANK: Record<GitFileStatus, number> = { ignored: 0, renamed: 1, added: 2, untracked: 3, modified: 4, deleted: 5, conflicted: 6 };

/** Maps entries to absolute paths and rolls statuses up to their folders (ignored doesn't roll up). */
export function badgesFor(git: GitStatus | null): Record<string, GitFileStatus> {
  const out: Record<string, GitFileStatus> = {};
  if (!git) return out;
  const root = git.root.replace(/\/$/, "");
  for (const e of git.entries) {
    const rel = e.path.replace(/\/$/, "");
    out[`${root}/${rel}`] = e.status;
    if (e.status === "ignored") continue;
    const parts = rel.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = `${root}/${parts.slice(0, i).join("/")}`;
      const cur = out[dir];
      if (cur && cur !== "ignored" && RANK[cur] >= RANK[e.status]) break;
      out[dir] = e.status;
    }
  }
  return out;
}

/** The status shown for `path`: its own, else ignored if it's inside an ignored folder. */
export function statusOf(badges: Record<string, GitFileStatus>, path: string, gitRoot: string | null): GitFileStatus | undefined {
  if (badges[path]) return badges[path];
  if (!gitRoot || !path.startsWith(gitRoot)) return undefined;
  for (let p = path; p.length > gitRoot.length; p = p.slice(0, p.lastIndexOf("/"))) {
    if (badges[p] === "ignored") return "ignored";
  }
  return undefined;
}

let gitTimer = 0;

export const useFiles = create<FilesState>((set, get) => ({
  root: null,
  follow: true,
  dirs: {},
  open: {},
  selected: null,
  git: null,
  badges: {},

  setRoot: (root, opts) => {
    const cur = get().root;
    const follow = opts?.follow ?? get().follow;
    if (cur && root && cur.host === root.host && cur.path === root.path) {
      set({ follow });
      return;
    }
    const sameHost = cur?.host === root?.host;
    set({ root, follow, selected: null, ...(sameHost ? {} : { dirs: {}, open: {}, git: null, badges: {} }) });
    if (root) {
      void get().load(root.path);
      void get().refreshGit();
    }
  },

  setFollow: (follow) => set({ follow }),

  load: async (path) => {
    const root = get().root;
    if (!root) return;
    set((s) => ({ dirs: { ...s.dirs, [path]: { entries: s.dirs[path]?.entries ?? null, loading: true, error: null } } }));
    try {
      const listing = await (await backend()).listDir(root.host, path);
      if (get().root?.host !== root.host) return;
      set((s) => ({ dirs: { ...s.dirs, [path]: { entries: listing.entries, loading: false, error: null } } }));
    } catch (e) {
      set((s) => ({ dirs: { ...s.dirs, [path]: { entries: null, loading: false, error: String(e) } } }));
    }
  },

  toggle: (path) => {
    const open = { ...get().open };
    if (open[path]) delete open[path];
    else {
      open[path] = true;
      if (!get().dirs[path]?.entries) void get().load(path);
    }
    set({ open });
  },

  collapseAll: () => set({ open: {} }),
  select: (selected) => set({ selected }),

  refresh: async () => {
    const { root, open } = get();
    if (!root) return;
    await Promise.all([get().load(root.path), ...Object.keys(open).map((p) => get().load(p)), get().refreshGit()]);
  },

  refreshGit: async () => {
    const root = get().root;
    if (!root) return;
    window.clearTimeout(gitTimer);
    try {
      const git = await (await backend()).gitStatus(root.host, root.path);
      if (get().root?.host === root.host && get().root?.path === root.path) set({ git, badges: badgesFor(git) });
    } catch {
      set({ git: null, badges: {} });
    }
  },
}));

/** Child path helper shared with the panel. */
export const childPath = joinPath;
