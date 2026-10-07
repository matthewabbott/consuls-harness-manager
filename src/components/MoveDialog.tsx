// Where to move or copy an explorer item: a folder on the same machine, browsed like the
// explorer (places, crumbs, back / forward). A copy into a folder where the name is taken gets
// " (1)"; a move there is refused.

import { CornerLeftUp, Folder, Loader2 } from "lucide-react";
import { useState } from "react";

import { backend } from "../ipc/backend";
import { hostLabel } from "../lib/hosts";
import { baseName, freeName, isRoot, isWithin, joinPath, parentPath, sameFolder } from "../lib/paths";
import { historyStep } from "../lib/platform";
import { useFolder } from "../lib/useFolder";
import { useRedact } from "../store/recording";
import FolderNav from "./FolderNav";
import Modal, { Button } from "./Modal";
import PlacesBar from "./PlacesBar";

interface Props {
  host: string;
  /** The item to move or copy. */
  path: string;
  mode: "move" | "copy";
  onDone(to: string): void;
  onClose(): void;
}

export default function MoveDialog({ host, path, mode, onDone, onClose }: Props) {
  const folder = useFolder(host, parentPath(path));
  const r = useRedact();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = baseName(path);
  const cwd = folder.path;
  const dirs = (folder.listing?.entries ?? []).filter((e) => e.isDir);
  // A folder can't go inside itself; a move to where it already is does nothing.
  const inside = !!cwd && isWithin(cwd, path);
  const same = !!cwd && sameFolder(cwd, parentPath(path));
  const blocked = !folder.listing || busy || inside || (mode === "move" && same);

  const go = async () => {
    if (!folder.listing || blocked) return;
    const taken = new Set(folder.listing.entries.map((e) => e.name));
    if (mode === "move" && taken.has(name)) return setError(`${name} already exists there`);
    const to = joinPath(folder.listing.path, mode === "copy" ? freeName(name, taken) : name);
    setBusy(true);
    setError(null);
    try {
      await (await backend()).fsOp(host, mode === "move" ? { kind: "rename", from: path, to } : { kind: "copy", from: path, to });
      onDone(to);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${mode === "move" ? "Move" : "Copy"} “${r(name)}” to…`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={() => void go()} disabled={blocked}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === "move" ? "Move here" : "Copy here"}
          </Button>
        </>
      }
    >
      <div
        className="space-y-2"
        onKeyDown={(e) => {
          const dir = historyStep(e);
          if (dir) {
            e.preventDefault();
            if (dir < 0) folder.back();
            else folder.forward();
          }
        }}
      >
        <PlacesBar host={host} path={cwd} onGo={folder.go} />
        <div className="overflow-hidden rounded-xl bg-ink-900/70 ring-1 ring-ink-700">
          <div className="border-b border-ink-700 px-1.5 py-1.5">
            <FolderNav
              host={host}
              path={cwd}
              onGo={folder.go}
              canBack={folder.canBack}
              canForward={folder.canForward}
              onBack={folder.back}
              onForward={folder.forward}
              trailing={folder.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}
            />
          </div>
          <div className="scroll-thin h-64 overflow-y-auto py-1">
            {cwd && !isRoot(cwd) && (
              <button onClick={() => folder.go(parentPath(cwd))} className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12.5px] text-mist-400 hover:bg-ink-750">
                <CornerLeftUp className="h-3.5 w-3.5" /> ..
              </button>
            )}
            {dirs.map((d) => {
              const p = joinPath(cwd ?? "", d.name);
              const self = sameFolder(p, path);
              return (
                <button
                  key={d.name}
                  disabled={self}
                  onClick={() => folder.go(p)}
                  className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12.5px] text-mist-200 hover:bg-ink-750 disabled:opacity-40"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
                  <span className="truncate">{r(d.name)}</span>
                </button>
              );
            })}
            {folder.listing && dirs.length === 0 && <p className="px-2.5 py-1 text-[12px] text-mist-500 italic">No folders here</p>}
          </div>
        </div>
        <p className="text-[11.5px] text-mist-500">
          On {r(hostLabel(host))}
          {inside ? " · it can't go inside itself" : mode === "move" && same ? " · it's already here" : ""}
        </p>
        {(error || folder.error) && <p className="text-[12px] text-rose-400">{r(error ?? folder.error ?? "")}</p>}
      </div>
    </Modal>
  );
}
