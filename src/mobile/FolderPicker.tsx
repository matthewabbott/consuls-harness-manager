// Where to move or copy something on the phone: a folder on the same machine, browsed like the
// file browser (places, path, back / forward).

import { ChevronRight, CornerLeftUp, Folder, Loader2, X } from "lucide-react";
import { useState } from "react";

import type { DirListing } from "../ipc/bindings/DirListing";
import { isRoot, joinPath, parentPath } from "../lib/paths";
import { useApp } from "../store/app";
import FolderBar, { Places } from "./FolderBar";
import { useFolder } from "../lib/useFolder";

interface Props {
  host: string;
  start: string;
  title: string;
  /** The button: "Move here", "Copy here". */
  action: string;
  /** Resolves when done; a rejection is shown and the picker stays. */
  onPick(dir: string, listing: DirListing): Promise<void>;
  onClose(): void;
}

export default function FolderPicker({ host, start, title, action, onPick, onClose }: Props) {
  const folder = useFolder(host, start);
  const home = useApp((s) => s.hosts[host]?.facts?.home ?? null) ?? folder.listing?.home ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cwd = folder.path ?? "";
  const dirs = (folder.listing?.entries ?? []).filter((e) => e.isDir && !e.name.startsWith("."));

  const pick = async () => {
    if (!folder.listing) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(folder.listing.path, folder.listing);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900">
      <header className="safe-top flex shrink-0 items-center gap-1 px-1.5 pb-2">
        <button onClick={onClose} aria-label="Cancel" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <X className="h-6 w-6" />
        </button>
        <h1 className="personal min-w-0 flex-1 truncate text-[17px] font-semibold text-mist-100">{title}</h1>
      </header>
      <div className="shrink-0 space-y-2 px-3 pb-2">
        <Places host={host} path={folder.path} home={home} onGo={folder.go} />
        <FolderBar folder={folder} home={home} />
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto border-t border-ink-700/80">
        {folder.loading && !folder.listing && (
          <p className="flex items-center gap-2 px-4 py-3 text-[14px] text-mist-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {cwd && !isRoot(cwd) && (
          <button onClick={() => folder.go(parentPath(cwd))} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-mist-300 active:bg-ink-800">
            <CornerLeftUp className="h-5 w-5" /> Up
          </button>
        )}
        {dirs.map((d) => (
          <button key={d.name} onClick={() => folder.go(joinPath(cwd, d.name))} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-mist-100 active:bg-ink-800">
            <Folder className="h-5 w-5 shrink-0 text-ember-400/80" />
            <span className="personal min-w-0 flex-1 truncate">{d.name}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-mist-600" />
          </button>
        ))}
        {folder.listing && dirs.length === 0 && <p className="px-4 py-3 text-[14px] text-mist-500">No folders here.</p>}
        {(folder.error || error) && <p className="px-4 py-2 text-[13px] text-rose-400">{error ?? folder.error}</p>}
      </main>
      <div className="safe-bottom shrink-0 border-t border-ink-700/80 px-4 pt-3">
        <button
          disabled={!folder.listing || busy}
          onClick={() => void pick()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {action}
        </button>
      </div>
    </div>
  );
}
