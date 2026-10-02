// The phone's file browser, per machine: folders and files, opened in a viewer; rename, move,
// copy, delete and download from an item's ⋯; new folders and uploads from the header. Moves and
// copies stay on one machine.

import {
  ChevronRight,
  Clipboard,
  Copy,
  CornerLeftUp,
  Download,
  Eye,
  EyeOff,
  File,
  FileImage,
  FileSymlink,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  FolderSymlink,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { DirEntryInfo } from "../ipc/bindings/DirEntryInfo";
import type { FsOp } from "../ipc/bindings/FsOp";
import { freeName, isRoot, joinPath, parentPath, sameFolder } from "../lib/paths";
import { fmtSize, fmtWhen } from "../lib/sizes";
import { uiStorage } from "../lib/uiState";
import { useApp } from "../store/app";
import Chip from "./Chip";
import FileViewer from "./FileViewer";
import { download, type FilesAt, onUploaded, upload } from "./files";
import FolderBar, { Places } from "./FolderBar";
import FolderPicker from "./FolderPicker";
import { Sheet, SheetAction } from "./Sheet";
import TransfersPanel from "./TransfersPanel";
import { useFolder } from "./useFolder";

const SHOW_HIDDEN = "consuls.files.hidden";
const TEXT = /\.(txt|md|json|ya?ml|toml|ini|cfg|conf|log|csv|rs|ts|tsx|js|jsx|mjs|py|sh|zsh|bash|go|rb|c|h|cpp|hpp|java|kt|swift|html|css|scss|sql|xml|lock)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|heic|avif)$/i;

function EntryIcon({ e }: { e: DirEntryInfo }) {
  const cls = "h-5 w-5 shrink-0";
  if (e.isDir) return e.isSymlink ? <FolderSymlink className={`${cls} text-ember-400/80`} /> : <Folder className={`${cls} text-ember-400/80`} />;
  if (e.isSymlink) return <FileSymlink className={`${cls} text-mist-400`} />;
  if (IMAGE.test(e.name)) return <FileImage className={`${cls} text-sky-300/80`} />;
  if (TEXT.test(e.name)) return <FileText className={`${cls} text-mist-400`} />;
  return <File className={`${cls} text-mist-500`} />;
}

const fail = (e: unknown) => useApp.getState().notify("error", String(e));

export default function FilesScreen({ at, onClose }: { at: FilesAt; onClose(): void }) {
  const hosts = useApp((s) => s.hosts);
  const selfName = useApp((s) => s.tailnet?.selfNode?.id ?? "this machine");
  const defaults = useApp((s) => s.config.ui.defaultFolders);
  const connected = Object.values(hosts)
    .filter((h) => h.phase.phase === "connected")
    .map((h) => h.id);
  const name = (id: string) => (id === "@local" ? selfName : id);

  const [host, setHost] = useState(at.host);
  // Where each machine opens: where asked (this one), else its default folder, else home.
  const [startAt] = useState(() => new Map([[at.host, at.dir]]));
  if (!startAt.has(host)) startAt.set(host, defaults[host] ?? "~");
  const folder = useFolder(host, startAt.get(host)!);
  const home = hosts[host]?.facts?.home ?? folder.listing?.home ?? null;
  const cwd = folder.path ?? "";

  const [showHidden, setShowHidden] = useState(() => uiStorage.getItem(SHOW_HIDDEN) === "1");
  const [viewing, setViewing] = useState<{ path: string; size?: number; line?: number } | null>(at.file ?? null);
  const [menu, setMenu] = useState(false);
  const [item, setItem] = useState<DirEntryInfo | null>(null);
  const [naming, setNaming] = useState<{ entry: DirEntryInfo | null } | null>(null);
  const [picking, setPicking] = useState<{ entry: DirEntryInfo; mode: "move" | "copy" } | null>(null);
  const [deleting, setDeleting] = useState<{ entry: DirEntryInfo; count: number | null } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // An upload landed in the folder shown: show it.
  const reload = folder.reload;
  useEffect(() => onUploaded((h, dir) => h === host && !!cwd && sameFolder(dir, cwd) && reload()), [host, cwd, reload]);

  const entries = (folder.listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
  const pathOf = (e: DirEntryInfo) => joinPath(cwd, e.name);
  const op = async (o: FsOp) => {
    await (await backend()).fsOp(host, o);
    folder.reload();
  };
  const toggleHidden = () => {
    uiStorage.setItem(SHOW_HIDDEN, showHidden ? "0" : "1");
    setShowHidden(!showHidden);
    setMenu(false);
  };
  const askDelete = (entry: DirEntryInfo) => {
    setItem(null);
    setDeleting({ entry, count: entry.isDir ? null : 0 });
    if (entry.isDir) {
      void backend()
        .then((b) => b.fsCount(host, pathOf(entry)))
        .then((count) => setDeleting((d) => (d && d.entry === entry ? { entry, count } : d)), fail);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink-900">
      <header className="safe-top flex shrink-0 items-center gap-1 px-1.5 pb-1">
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <X className="h-6 w-6" />
        </button>
        <div className="ml-1 min-w-0 flex-1">
          <h1 className="text-[18px] leading-tight font-semibold text-mist-100">Files</h1>
          <div className="truncate text-[12px] text-mist-500">{name(host)}</div>
        </div>
        {folder.loading && <Loader2 className="h-4.5 w-4.5 animate-spin text-mist-500" />}
        <button onClick={() => fileInput.current?.click()} disabled={!folder.listing} aria-label="Upload files here" className="rounded-full p-2 text-mist-200 active:bg-ink-700 disabled:text-mist-600">
          <Upload className="h-5.5 w-5.5" />
        </button>
        <button onClick={() => setMenu(true)} aria-label="More" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
          <MoreHorizontal className="h-5.5 w-5.5" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length && cwd) upload(host, cwd, files);
          }}
        />
      </header>

      <div className="shrink-0 space-y-2 px-3 pb-2">
        {connected.length > 1 && (
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {connected.map((h) => (
              <Chip key={h} on={h === host} onClick={() => setHost(h)}>
                {name(h)}
              </Chip>
            ))}
          </div>
        )}
        <Places host={host} path={folder.path} home={home} onGo={folder.go} />
        <FolderBar folder={folder} home={home} />
        {folder.error && <p className="text-[13px] text-rose-400">{folder.error}</p>}
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto border-t border-ink-700/80">
        {folder.loading && !folder.listing && (
          <p className="flex items-center gap-2 px-4 py-3 text-[14px] text-mist-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {cwd && !isRoot(cwd) && (
          <button onClick={() => folder.go(parentPath(cwd))} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-mist-300 active:bg-ink-800">
            <CornerLeftUp className="h-5 w-5" /> Up
          </button>
        )}
        {entries.map((e) => (
          <div key={e.name} className="flex items-center">
            <button
              onClick={() => (e.isDir ? folder.go(pathOf(e)) : setViewing({ path: pathOf(e), size: e.size }))}
              className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left active:bg-ink-800"
            >
              <EntryIcon e={e} />
              <span className="min-w-0 flex-1">
                <span className="personal block truncate text-[15px] text-mist-100">{e.name}</span>
                <span className="block text-[12px] text-mist-500">{e.isDir ? fmtWhen(e.mtime) : `${fmtSize(e.size)} · ${fmtWhen(e.mtime)}`}</span>
              </span>
              {e.isDir && <ChevronRight className="h-4 w-4 shrink-0 text-mist-600" />}
            </button>
            <button onClick={() => setItem(e)} aria-label={`More for ${e.name}`} className="shrink-0 px-3 py-3 text-mist-500 active:text-mist-200">
              <MoreHorizontal className="h-5 w-5" />
            </button>
          </div>
        ))}
        {folder.listing && entries.length === 0 && <p className="px-4 py-3 text-[14px] text-mist-500">{folder.listing.entries.length ? "Only hidden files here." : "Empty folder."}</p>}
      </main>

      <TransfersPanel />

      {menu && (
        <Sheet onClose={() => setMenu(false)}>
          <SheetAction
            onClick={() => {
              setMenu(false);
              setNaming({ entry: null });
            }}
          >
            <FolderPlus className="h-5 w-5 text-mist-400" /> New folder
          </SheetAction>
          <SheetAction onClick={toggleHidden}>
            {showHidden ? <EyeOff className="h-5 w-5 text-mist-400" /> : <Eye className="h-5 w-5 text-mist-400" />}
            {showHidden ? "Hide hidden files" : "Show hidden files"}
          </SheetAction>
          <SheetAction
            onClick={() => {
              setMenu(false);
              folder.reload();
            }}
          >
            <RefreshCw className="h-5 w-5 text-mist-400" /> Refresh
          </SheetAction>
          <SheetAction
            onClick={() => {
              setMenu(false);
              void navigator.clipboard.writeText(cwd).then(() => useApp.getState().notify("info", "Copied the folder's path."), fail);
            }}
          >
            <Clipboard className="h-5 w-5 text-mist-400" /> Copy this folder's path
          </SheetAction>
        </Sheet>
      )}

      {item && (
        <Sheet onClose={() => setItem(null)}>
          <div className="personal truncate px-3 pt-1 pb-2 text-[14px] font-medium text-mist-300">{item.name}</div>
          {!item.isDir && (
            <SheetAction
              onClick={() => {
                setItem(null);
                void download(host, pathOf(item), item.size);
              }}
            >
              <Download className="h-5 w-5 text-mist-400" /> Download
            </SheetAction>
          )}
          <SheetAction
            onClick={() => {
              setItem(null);
              setNaming({ entry: item });
            }}
          >
            <Pencil className="h-5 w-5 text-mist-400" /> Rename
          </SheetAction>
          <SheetAction
            onClick={() => {
              setItem(null);
              setPicking({ entry: item, mode: "move" });
            }}
          >
            <FolderInput className="h-5 w-5 text-mist-400" /> Move to…
          </SheetAction>
          <SheetAction
            onClick={() => {
              setItem(null);
              setPicking({ entry: item, mode: "copy" });
            }}
          >
            <Copy className="h-5 w-5 text-mist-400" /> Copy to…
          </SheetAction>
          <SheetAction
            onClick={() => {
              setItem(null);
              void navigator.clipboard.writeText(pathOf(item)).then(() => useApp.getState().notify("info", "Copied the path."), fail);
            }}
          >
            <Clipboard className="h-5 w-5 text-mist-400" /> Copy path
          </SheetAction>
          <SheetAction danger onClick={() => askDelete(item)}>
            <Trash2 className="h-5 w-5" /> Delete
          </SheetAction>
        </Sheet>
      )}

      {naming && (
        <NameSheet
          title={naming.entry ? "Rename" : "New folder"}
          initial={naming.entry?.name ?? ""}
          action={naming.entry ? "Rename" : "Create"}
          onClose={() => setNaming(null)}
          onSave={async (newName) => {
            const entry = naming.entry;
            if (entry) {
              if (newName !== entry.name) await op({ kind: "rename", from: pathOf(entry), to: joinPath(cwd, newName) });
            } else {
              await op({ kind: "mkdir", path: joinPath(cwd, newName) });
            }
          }}
        />
      )}

      {picking && (
        <FolderPicker
          host={host}
          start={cwd}
          title={`${picking.mode === "move" ? "Move" : "Copy"} “${picking.entry.name}” to…`}
          action={picking.mode === "move" ? "Move here" : "Copy here"}
          onClose={() => setPicking(null)}
          onPick={async (dir, listing) => {
            const { entry, mode } = picking;
            const taken = new Set(listing.entries.map((e) => e.name));
            if (mode === "move") {
              if (sameFolder(dir, cwd)) return;
              if (taken.has(entry.name)) throw `${entry.name} already exists there`;
              await op({ kind: "rename", from: pathOf(entry), to: joinPath(dir, entry.name) });
              useApp.getState().notify("info", `Moved ${entry.name}.`);
            } else {
              await op({ kind: "copy", from: pathOf(entry), to: joinPath(dir, freeName(entry.name, taken)) });
              useApp.getState().notify("info", `Copied ${entry.name}.`);
            }
          }}
        />
      )}

      {deleting && (
        <Sheet onClose={() => setDeleting(null)}>
          <div className="px-2 pb-3">
            <div className="personal text-[16px] font-semibold break-words text-mist-100">Delete “{deleting.entry.name}”?</div>
            <p className="mt-1 text-[14px] text-mist-400">
              {!deleting.entry.isDir
                ? "It can't be brought back."
                : deleting.count === null
                  ? "Counting what's inside…"
                  : deleting.count === 0
                    ? "The folder is empty."
                    : `This deletes the folder and the ${deleting.count > 100_000 ? "100,000+" : deleting.count.toLocaleString()} item${deleting.count === 1 ? "" : "s"} in it. It can't be brought back.`}
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setDeleting(null)} className="flex-1 rounded-xl bg-ink-700 py-3 text-[16px] font-medium text-mist-100 active:bg-ink-600">
                Cancel
              </button>
              <button
                disabled={deleting.count === null}
                onClick={() => {
                  const entry = deleting.entry;
                  setDeleting(null);
                  void op({ kind: "remove", path: pathOf(entry) }).then(() => useApp.getState().notify("info", `Deleted ${entry.name}.`), fail);
                }}
                className="flex-1 rounded-xl bg-rose-500 py-3 text-[16px] font-semibold text-white active:opacity-80 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {viewing && <FileViewer host={host} path={viewing.path} size={viewing.size} line={viewing.line} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** A name for a new folder or a renamed item; the name without its extension starts selected. */
function NameSheet({ title, initial, action, onSave, onClose }: { title: string; initial: string; action: string; onSave(name: string): Promise<void>; onClose(): void }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const save = async () => {
    const name = value.trim();
    if (!name) return;
    if (name.includes("/")) return setError("A name can't contain /");
    setBusy(true);
    setError(null);
    try {
      await onSave(name);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <Sheet onClose={onClose}>
      <div className="px-1 pb-2">
        <div className="mb-2 text-[13px] text-mist-400">{title}</div>
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          enterKeyHint="done"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="personal w-full rounded-xl bg-ink-800 px-3.5 py-3 text-[16px] text-mist-100 ring-1 ring-ink-700 outline-none focus:ring-ember-400/60"
        />
        {error && <p className="mt-2 text-[13px] text-rose-400">{error}</p>}
        <button
          disabled={busy || !value.trim()}
          onClick={() => void save()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {action}
        </button>
      </div>
    </Sheet>
  );
}
