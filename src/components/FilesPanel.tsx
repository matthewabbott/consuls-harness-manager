import {
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderInput,
  FolderPlus,
  FolderRoot,
  FolderUp,
  FolderSearch,
  GitBranch,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  ChevronsDownUp,
  SquareCode,
  SquareTerminal,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { backend, inTauri } from "../ipc/backend";
import type { DirEntryInfo } from "../ipc/bindings/DirEntryInfo";
import type { GitFileStatus } from "../ipc/bindings/GitFileStatus";
import { canBack, canForward } from "../lib/history";
import { hostLabel, isLocal, LOCAL_HOST } from "../lib/hosts";
import { canOpenInVsCode, openInVsCode, REVEAL_LABEL, revealPath, useVsCode } from "../lib/openers";
import { baseName, freeName, joinPath, parentPath } from "../lib/paths";
import { historyStep, isDeleteKey, isMac, keyLabel } from "../lib/platform";
import { useApp } from "../store/app";
import { useEditor } from "../store/editor";
import { startFolder, statusOf, useFiles } from "../store/files";
import { setDefaultFolder } from "../store/prefs";
import { useRedact } from "../store/recording";
import { downloadFrom, uploadTo } from "../store/transfers";
import FolderNav from "./FolderNav";
import HideSidebarButton from "./HideSidebarButton";
import Modal, { Button } from "./Modal";
import MoveDialog from "./MoveDialog";
import PlacesBar from "./PlacesBar";
import TransfersList from "./TransfersList";
import { type Dragged, folderAt, useTreeDrag } from "./useTreeDrag";

const ROW_H = 22;
const OVERSCAN = 12;

const STATUS: Record<GitFileStatus, { letter: string; cls: string; title: string }> = {
  modified: { letter: "M", cls: "text-ember-300", title: "Modified" },
  added: { letter: "A", cls: "text-jade-300", title: "Added" },
  untracked: { letter: "U", cls: "text-jade-400", title: "Untracked" },
  deleted: { letter: "D", cls: "text-rose-400", title: "Deleted" },
  renamed: { letter: "R", cls: "text-sky-300", title: "Renamed" },
  conflicted: { letter: "!", cls: "text-rose-400", title: "Conflict" },
  ignored: { letter: "", cls: "text-mist-600", title: "Ignored" },
};

type Row =
  | { kind: "entry"; path: string; entry: DirEntryInfo; depth: number }
  | { kind: "edit"; depth: number; parent: string; dir: boolean }
  | { kind: "note"; depth: number; text: string; error?: boolean };

interface Edit {
  kind: "newFile" | "newFolder" | "rename";
  /** Folder that gets the new item, or the item being renamed. */
  path: string;
}

interface Menu {
  x: number;
  y: number;
  path: string | null;
  isDir: boolean;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPanel() {
  const root = useFiles((s) => s.root);
  const follow = useFiles((s) => s.follow);
  const dirs = useFiles((s) => s.dirs);
  const open = useFiles((s) => s.open);
  const selected = useFiles((s) => s.selected);
  const badges = useFiles((s) => s.badges);
  const git = useFiles((s) => s.git);
  const history = useFiles((s) => s.history);
  const files = useFiles.getState;
  const vscode = useVsCode();
  const r = useRedact();

  const hosts = useApp((s) => s.hosts);
  const expandedPane = useApp((s) => (s.expanded === null ? null : (Object.values(s.panes).flat().find((p) => p.key === s.expanded) ?? null)));
  const connected = Object.values(hosts)
    .filter((h) => h.phase.phase === "connected")
    .map((h) => h.id)
    .sort((a, b) => Number(b === LOCAL_HOST) - Number(a === LOCAL_HOST));

  const [edit, setEdit] = useState<Edit | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; isDir: boolean; count: number | null } | null>(null);
  const [moving, setMoving] = useState<{ path: string; mode: "move" | "copy" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The folder files dragged in from Finder / File Explorer would go into.
  const [dropDir, setDropDir] = useState<string | null>(null);
  // Uploads and downloads are between this computer and another machine.
  const remote = !!root && !isLocal(root.host);

  // Follow the expanded pane's working directory.
  useEffect(() => {
    if (follow && expandedPane) files().setRoot({ host: expandedPane.host, path: expandedPane.currentPath });
  }, [follow, expandedPane?.host, expandedPane?.currentPath, files, expandedPane]);

  // With nothing to follow, start at a machine's default folder (or home).
  useEffect(() => {
    if (root || expandedPane) return;
    const host = connected[0];
    const start = host ? startFolder(host) : null;
    if (host && start) files().setRoot({ host, path: start });
  }, [root, expandedPane, connected, hosts, files]);

  // Git badges stay fresh while the panel is open.
  useEffect(() => {
    const t = window.setInterval(() => void files().refreshGit(), 10_000);
    const onFocus = () => void files().refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [files]);

  // Files dropped from the OS go into the folder under the pointer (as with dragging inside the
  // explorer: a folder row, a file's folder, a crumb or place, the root below the rows).
  const rootRef = useRef(root);
  rootRef.current = root;
  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    // Where the pointer is on the page. Windows reports physical pixels. On macOS the web view
    // runs up under the title bar while the page starts below it, so the web view's coordinates
    // (Tauri's, and AppKit's from `pointer.rs`) are lower by what the page's viewport doesn't
    // cover: the web view's height minus the page's.
    const place = async (position: { x: number; y: number }) => {
      if (isMac) {
        const { invoke } = await import("@tauri-apps/api/core");
        const at = await invoke<[number, number, number] | null>("pointer_in_page").catch(() => null);
        if (!at) return position;
        const [x, y, height] = at;
        return { x, y: y - Math.max(0, height - window.innerHeight) };
      }
      const ratio = window.devicePixelRatio || 1;
      return { x: position.x / ratio, y: position.y / ratio };
    };
    // Positions arrive asynchronously: one that's been overtaken (or outlived the drag) is dropped.
    let latest = 0;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((e) => {
          const p = e.payload;
          const n = ++latest;
          if (p.type === "leave") return setDropDir(null);
          void place(p.position).then(({ x, y }) => {
            if (p.type !== "drop" && n !== latest) return;
            const current = rootRef.current;
            const dir = current ? folderAt(x, y, current.path) : null;
            if (p.type !== "drop") return setDropDir(dir);
            setDropDir(null);
            if (!dir || !current || p.paths.length === 0) return;
            // Our own drag out of the window, brought back: not files to upload.
            if (p.paths.some((f) => /[\\/]consuls-drag[\\/]/.test(f))) return;
            if (isLocal(current.host)) {
              useApp.getState().notify("info", "Those files are on this computer already: drop them on another machine's files to upload them.");
              return;
            }
            void uploadTo(current.host, dir, p.paths);
          });
        })
        .then((u) => (gone ? u() : (unlisten = u))),
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  /** A dragged item let go over a folder: moved there (copied with Option / Alt). */
  const dropInto = (item: Dragged, dir: string, copy: boolean) => {
    if (!root) return;
    const host = root.host;
    void run(async () => {
      const b = await backend();
      const entries = files().dirs[dir]?.entries ?? (await b.listDir(host, dir)).entries;
      const taken = new Set(entries.map((e) => e.name));
      if (!copy && taken.has(item.name)) throw `${item.name} already exists in ${baseName(dir)}`;
      const to = joinPath(dir, copy ? freeName(item.name, taken) : item.name);
      await b.fsOp(host, copy ? { kind: "copy", from: item.path, to } : { kind: "rename", from: item.path, to });
      for (const d of new Set([parentPath(item.path), dir])) if (files().dirs[d]) await files().load(d);
      if (!copy && files().selected === item.path) files().select(to);
      void files().refreshGit();
    });
  };
  const { drag, begin } = useTreeDrag(root?.host ?? null, root?.path ?? null, dropInto);
  // The folder something's being dragged into: from this window, or from Finder / File Explorer.
  const target = drag ? drag.target : dropDir;

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!root) return out;
    const walk = (dir: string, depth: number) => {
      const d = dirs[dir];
      if (edit && edit.kind !== "rename" && edit.path === dir) out.push({ kind: "edit", depth, parent: dir, dir: edit.kind === "newFolder" });
      if (!d?.entries) {
        if (d?.error) out.push({ kind: "note", depth, text: d.error, error: true });
        else out.push({ kind: "note", depth, text: "Loading…" });
        return;
      }
      if (d.entries.length === 0 && !(edit && edit.path === dir)) out.push({ kind: "note", depth, text: "Empty folder" });
      for (const entry of d.entries) {
        const path = joinPath(dir, entry.name);
        out.push({ kind: "entry", path, entry, depth });
        if (entry.isDir && open[path]) walk(path, depth + 1);
      }
    };
    walk(root.path, 0);
    return out;
  }, [root, dirs, open, edit]);

  // Virtualized list.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };

  const submitEdit = (name: string) => {
    const e = edit;
    setEdit(null);
    if (!e || !root || !name.trim() || name.includes("/")) return;
    const host = root.host;
    void run(async () => {
      const b = await backend();
      if (e.kind === "rename") {
        const to = joinPath(parentPath(e.path), name.trim());
        if (to === e.path) return;
        await b.fsOp(host, { kind: "rename", from: e.path, to });
        await files().load(parentPath(e.path));
        files().select(to);
      } else {
        const path = joinPath(e.path, name.trim());
        await b.fsOp(host, e.kind === "newFolder" ? { kind: "mkdir", path } : { kind: "createFile", path });
        await files().load(e.path);
        files().select(path);
      }
      void files().refreshGit();
    });
  };

  const startNew = (kind: "newFile" | "newFolder", dir: string) => {
    if (root && dir !== root.path && !open[dir]) files().toggle(dir);
    setEdit({ kind, path: dir });
  };

  const askDelete = (path: string, isDir: boolean) => {
    if (!root) return;
    setConfirmDelete({ path, isDir, count: isDir ? null : 0 });
    if (isDir)
      void backend()
        .then((b) => b.fsCount(root.host, path))
        .then((count) => setConfirmDelete((c) => (c && c.path === path ? { ...c, count } : c)))
        .catch(() => setConfirmDelete((c) => (c && c.path === path ? { ...c, count: -1 } : c)));
  };

  const doDelete = () => {
    const c = confirmDelete;
    setConfirmDelete(null);
    if (!c || !root) return;
    void run(async () => {
      await (await backend()).fsOp(root.host, { kind: "remove", path: c.path });
      await files().load(parentPath(c.path));
      if (selected === c.path) files().select(null);
      void files().refreshGit();
    });
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const relative = (path: string) => (git && path.startsWith(git.root) ? path.slice(git.root.length + 1) : root ? path.slice(root.path.length + 1) : path);

  // Keyboard: Alt+←/→ (also ⌘[ ⌘] on macOS) back/forward, F2 rename, Delete (⌘⌫ on macOS)
  // delete, Enter/Space toggles folders.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = historyStep(e);
    if (step) {
      e.preventDefault();
      if (step < 0) files().back();
      else files().forward();
      return;
    }
    if (!selected || edit) return;
    const row = rows.find((r) => r.kind === "entry" && r.path === selected);
    if (!row || row.kind !== "entry") return;
    if (e.key === "F2") setEdit({ kind: "rename", path: selected });
    else if (isDeleteKey(e)) askDelete(selected, row.entry.isDir);
    else if ((e.key === "Enter" || e.key === " ") && row.entry.isDir) files().toggle(selected);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      // The mouse's back / forward buttons.
      onMouseUp={(e) => {
        if (e.button === 3 || e.button === 4) {
          e.preventDefault();
          if (e.button === 3) files().back();
          else files().forward();
        }
      }}
    >
      <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-1">
        <div className="flex-1 text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">Explorer</div>
        <HeaderButton title="New file" disabled={!root} onClick={() => root && startNew("newFile", root.path)}>
          <FilePlus className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton title="New folder" disabled={!root} onClick={() => root && startNew("newFolder", root.path)}>
          <FolderPlus className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton title="Refresh" disabled={!root} onClick={() => void files().refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton title="Collapse folders" disabled={!root} onClick={() => files().collapseAll()}>
          <ChevronsDownUp className="h-3.5 w-3.5" />
        </HeaderButton>
        <HideSidebarButton />
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
        <select
          value={root?.host ?? ""}
          onChange={(e) => {
            const host = e.target.value;
            const start = startFolder(host);
            if (start) files().setRoot({ host, path: start }, { follow: false });
          }}
          className="min-w-0 flex-1 truncate rounded-md bg-ink-800 px-1.5 py-1 text-[12px] text-mist-200 ring-1 ring-ink-700 outline-none"
        >
          {!root && <option value="">Pick a machine</option>}
          {connected.map((h) => (
            <option key={h} value={h}>
              {r(hostLabel(h))}
            </option>
          ))}
        </select>
        <button
          onClick={() => files().setFollow(!follow)}
          title={follow ? "Following the open pane's folder (click to stay here)" : "Follow the open pane's folder"}
          className={`rounded-md p-1 ${follow ? "text-sky-400" : "text-mist-500 hover:text-mist-200"}`}
        >
          {follow ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </button>
      </div>

      {root && (
        <div className="px-2.5 pb-1.5">
          <PlacesBar host={root.host} path={root.path} dropDir={target} onGo={(path) => files().setRoot({ host: root.host, path }, { follow: false })} />
        </div>
      )}

      {root && (
        <div className="px-1.5 pb-1.5">
          <FolderNav
            host={root.host}
            path={root.path}
            onGo={(path) => files().setRoot({ host: root.host, path }, { follow: false })}
            canBack={canBack(history)}
            canForward={canForward(history)}
            onBack={files().back}
            onForward={files().forward}
            dropDir={target}
            trailing={
              git?.branch && (
                <span className="flex items-center gap-1 text-mist-400" title={r(`git: ${git.root}`)}>
                  <GitBranch className="h-3 w-3" />
                  {git.branch}
                </span>
              )
            }
          />
        </div>
      )}

      {error && (
        <div className="mx-2.5 mb-1.5 rounded-md bg-rose-500/10 px-2 py-1.5 text-[11.5px] text-rose-300 ring-1 ring-rose-500/30">
          {r(error)}
        </div>
      )}

      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onContextMenu={(e) => {
          e.preventDefault();
          if (root) setMenu({ x: e.clientX, y: e.clientY, path: null, isDir: true });
        }}
        data-drop-root
        className={`scroll-thin relative min-h-0 flex-1 overflow-y-auto pb-6 outline-none ${
          target && root && target === root.path ? "bg-sky-400/5 ring-2 ring-sky-400/50 ring-inset" : ""
        }`}
      >
        {!root ? (
          <p className="px-3 py-2 text-[12px] leading-relaxed text-mist-500">Open a pane or pick a machine to browse its files.</p>
        ) : (
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(first, last).map((row, i) => {
              const top = (first + i) * ROW_H;
              const indent = 8 + row.depth * 12;
              if (row.kind === "note")
                return (
                  <div
                    key={`note-${first + i}`}
                    style={{ top, height: ROW_H, paddingLeft: indent + 16 }}
                    className={`absolute inset-x-0 flex items-center truncate text-[11.5px] italic ${row.error ? "text-rose-400" : "text-mist-500"}`}
                  >
                    {row.text}
                  </div>
                );
              if (row.kind === "edit")
                return (
                  <div key="edit" style={{ top, height: ROW_H, paddingLeft: indent + 16 }} className="absolute inset-x-0 flex items-center gap-1.5 pr-2">
                    {row.dir ? <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/80" /> : <File className="h-3.5 w-3.5 shrink-0 text-mist-500" />}
                    <NameInput initial="" onDone={submitEdit} />
                  </div>
                );
              const { path, entry } = row;
              const status = statusOf(badges, path, git?.root ?? null);
              const st = status ? STATUS[status] : null;
              const isOpen = !!open[path];
              const renaming = edit?.kind === "rename" && edit.path === path;
              return (
                <div
                  key={path}
                  data-path={path}
                  data-dir={entry.isDir ? "1" : undefined}
                  style={{ top, height: ROW_H, paddingLeft: indent }}
                  onPointerDown={(e) => !renaming && begin(e, { path, name: entry.name, isDir: entry.isDir, size: entry.size })}
                  onClick={() => {
                    files().select(path);
                    if (entry.isDir) files().toggle(path);
                    else void useEditor.getState().open(root.host, path, follow && expandedPane?.host === root.host ? expandedPane.key : null);
                  }}
                  // Double-clicking a folder browses from it (its two clicks cancel each other's toggle).
                  onDoubleClick={() => entry.isDir && files().setRoot({ host: root.host, path }, { follow: false })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    files().select(path);
                    setMenu({ x: e.clientX, y: e.clientY, path, isDir: entry.isDir });
                  }}
                  title={r(`${entry.name}${entry.isDir ? "" : ` · ${fmtSize(entry.size)}`}${entry.mtime ? ` · ${new Date(entry.mtime * 1000).toLocaleString()}` : ""}${st ? ` · ${st.title}` : ""}`)}
                  className={`absolute inset-x-0 flex cursor-pointer items-center gap-1 pr-2 text-[12.5px] ${
                    target === path
                      ? "bg-sky-400/20 ring-2 ring-sky-400/60 ring-inset"
                      : drag?.item.path === path
                        ? "opacity-50"
                      : selected === path
                        ? "bg-sky-400/15 ring-1 ring-sky-400/30 ring-inset"
                        : "hover:bg-ink-750"
                  }`}
                >
                  {entry.isDir ? (
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-mist-500 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  {entry.isDir ? (
                    isOpen ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
                    )
                  ) : (
                    <File className="h-3.5 w-3.5 shrink-0 text-mist-500" />
                  )}
                  {renaming ? (
                    <NameInput initial={entry.name} onDone={submitEdit} />
                  ) : (
                    <span
                      className={`min-w-0 flex-1 truncate ${st ? st.cls : "text-mist-200"} ${status === "deleted" ? "line-through" : ""} ${
                        entry.isSymlink ? "italic" : ""
                      }`}
                    >
                      {r(entry.name)}
                    </span>
                  )}
                  {st && status !== "ignored" && !renaming &&
                    (entry.isDir ? (
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${st.cls}`} />
                    ) : (
                      <span className={`w-3 shrink-0 text-center font-mono text-[10.5px] font-semibold ${st.cls}`}>{st.letter}</span>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && root && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          {(menu.path === null || menu.isDir) && (
            <>
              <MenuItem icon={<FilePlus className="h-3.5 w-3.5" />} onClick={() => startNew("newFile", menu.path ?? root.path)}>
                New file…
              </MenuItem>
              <MenuItem icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => startNew("newFolder", menu.path ?? root.path)}>
                New folder…
              </MenuItem>
              <MenuItem icon={<SquareTerminal className="h-3.5 w-3.5" />} onClick={() => useApp.getState().openNewPane(root.host, menu.path ?? root.path)}>
                New pane here…
              </MenuItem>
              {remote && (
                <>
                  <MenuItem icon={<Upload className="h-3.5 w-3.5" />} onClick={() => void uploadTo(root.host, menu.path ?? root.path, null)}>
                    Upload files here…
                  </MenuItem>
                  <MenuItem icon={<FolderUp className="h-3.5 w-3.5" />} onClick={() => void uploadTo(root.host, menu.path ?? root.path, null, true)}>
                    Upload a folder here…
                  </MenuItem>
                </>
              )}
            </>
          )}
          {menu.path && !menu.isDir && remote && (
            <MenuItem icon={<Download className="h-3.5 w-3.5" />} onClick={() => void downloadFrom(root.host, menu.path!)}>
              Download…
            </MenuItem>
          )}
          {menu.path && menu.isDir && (
            <MenuItem
              icon={<FolderRoot className="h-3.5 w-3.5" />}
              hint="dbl-click"
              onClick={() => files().setRoot({ host: root.host, path: menu.path! }, { follow: false })}
            >
              Browse from here
            </MenuItem>
          )}
          {(menu.path === null || menu.isDir) && (
            <MenuItem icon={<Star className="h-3.5 w-3.5" />} onClick={() => setDefaultFolder(root.host, menu.path ?? root.path)}>
              Make default folder on {r(hostLabel(root.host))}
            </MenuItem>
          )}
          {(isLocal(root.host) || canOpenInVsCode(vscode, root.host)) && <div className="my-1 h-px bg-ink-700" />}
          {isLocal(root.host) && (
            <MenuItem icon={<FolderSearch className="h-3.5 w-3.5" />} onClick={() => revealPath(root.host, menu.path ?? root.path)}>
              {REVEAL_LABEL}
            </MenuItem>
          )}
          {canOpenInVsCode(vscode, root.host) && (
            <MenuItem icon={<SquareCode className="h-3.5 w-3.5" />} onClick={() => openInVsCode(root.host, menu.path ?? root.path)}>
              Open in VS Code
            </MenuItem>
          )}
          {menu.path && (
            <>
              <div className="my-1 h-px bg-ink-700" />
              <MenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(menu.path!)}>
                Copy path
              </MenuItem>
              <MenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(relative(menu.path!))}>
                Copy relative path
              </MenuItem>
              <div className="my-1 h-px bg-ink-700" />
              <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} hint="F2" onClick={() => setEdit({ kind: "rename", path: menu.path! })}>
                Rename…
              </MenuItem>
              <MenuItem icon={<FolderInput className="h-3.5 w-3.5" />} onClick={() => setMoving({ path: menu.path!, mode: "move" })}>
                Move to…
              </MenuItem>
              <MenuItem icon={<CopyPlus className="h-3.5 w-3.5" />} onClick={() => setMoving({ path: menu.path!, mode: "copy" })}>
                Copy to…
              </MenuItem>
              <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} hint={keyLabel("Delete")} danger onClick={() => askDelete(menu.path!, menu.isDir)}>
                Delete…
              </MenuItem>
            </>
          )}
          {menu.path === null && (
            <MenuItem icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void files().refresh()}>
              Refresh
            </MenuItem>
          )}
        </ContextMenu>
      )}

      <TransfersList />

      {drag && <DragLabel drag={drag} />}

      {moving && root && (
        <MoveDialog
          host={root.host}
          path={moving.path}
          mode={moving.mode}
          onClose={() => setMoving(null)}
          onDone={(to) => {
            // Both folders, if they're shown.
            const shown = files().dirs;
            for (const dir of new Set([parentPath(moving.path), parentPath(to)])) if (shown[dir]) void files().load(dir);
            if (moving.mode === "move" && selected === moving.path) files().select(null);
            void files().refreshGit();
          }}
        />
      )}

      {confirmDelete && root && (
        <Modal
          title={`Delete “${r(confirmDelete.path.split("/").pop() ?? "")}”?`}
          onClose={() => setConfirmDelete(null)}
          width={440}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button kind="danger" onClick={doDelete} disabled={confirmDelete.count === null}>
                {confirmDelete.count === null && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-mist-300">
            {confirmDelete.isDir ? (
              <>
                This permanently deletes the folder{" "}
                {confirmDelete.count === null
                  ? "(counting its contents…)"
                  : confirmDelete.count < 0
                    ? "and everything in it"
                    : confirmDelete.count === 0
                      ? "(it's empty)"
                      : `and the ${confirmDelete.count > 100_000 ? "100,000+" : confirmDelete.count.toLocaleString()} item${confirmDelete.count === 1 ? "" : "s"} in it`}{" "}
                on {r(hostLabel(root.host))}.
              </>
            ) : (
              <>This permanently deletes the file on {r(hostLabel(root.host))}.</>
            )}{" "}
            It doesn't go to a trash or recycle bin.
          </p>
          <p className="mt-2 truncate font-mono text-[11.5px] text-mist-500" title={r(confirmDelete.path)}>
            {r(confirmDelete.path)}
          </p>
        </Modal>
      )}
    </div>
  );
}

function NameInput({ initial, onDone }: { initial: string; onDone(name: string): void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => {
        // Select the name without its extension, like VS Code.
        const dot = initial.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        if (e.key === "Escape") finish("");
      }}
      onBlur={() => finish(v)}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm bg-ink-900 px-1 text-[12.5px] text-mist-100 ring-1 ring-sky-400/60 outline-none"
    />
  );
}

function HeaderButton({ title, onClick, disabled, children }: { title: string; onClick(): void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} className="rounded p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40">
      {children}
    </button>
  );
}

function ContextMenu({ menu, onClose, children }: { menu: Menu; onClose(): void; children: React.ReactNode }) {
  const left = Math.min(menu.x, window.innerWidth - 230);
  // Kept on screen by its actual height (it grows with the item's actions).
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(menu.y);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)));
  }, [menu.y]);
  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={box}
        className="animate-rise absolute max-h-[calc(100vh-16px)] w-52 overflow-y-auto rounded-xl bg-ink-800 p-1 shadow-2xl ring-1 ring-ink-600"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        {children}
      </div>
    </div>
  );
}

function MenuItem({ icon, children, onClick, hint, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; hint?: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-ink-700 ${danger ? "text-rose-400" : "text-mist-200"}`}
    >
      <span className="text-mist-400">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint && <span className="font-mono text-[10.5px] text-mist-500">{hint}</span>}
    </button>
  );
}

/** What's being dragged and what letting go would do, beside the pointer. */
function DragLabel({ drag }: { drag: NonNullable<ReturnType<typeof useTreeDrag>["drag"]> }) {
  const r = useRedact();
  const hint = drag.target
    ? `${drag.copy ? "Copy" : "Move"} to ${r(baseName(drag.target))}`
    : drag.out.state === "no"
      ? drag.out.why
      : drag.out.state === "ready"
        ? "Drag out of the window to save it there"
        : "Getting it ready to drag out…";
  return (
    <div
      className="pointer-events-none fixed z-[60] max-w-72 rounded-lg bg-ink-800/95 px-2.5 py-1.5 shadow-2xl ring-1 ring-ink-600"
      style={{ left: drag.x + 14, top: drag.y + 12 }}
    >
      <div className="flex items-center gap-1.5 text-[12px] text-mist-100">
        {drag.item.isDir ? <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/80" /> : <File className="h-3.5 w-3.5 shrink-0 text-mist-400" />}
        <span className="truncate">{r(drag.item.name)}</span>
      </div>
      <div className={`mt-0.5 text-[11px] ${drag.target ? "text-sky-300" : "text-mist-500"}`}>{hint}</div>
    </div>
  );
}
