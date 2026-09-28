import { FileText, ImageIcon, X } from "lucide-react";
import { memo } from "react";

import { hostLabel, shortPath } from "../lib/hosts";
import { parentPath } from "../lib/paths";
import { useEditor } from "../store/editor";
import { useRedact } from "../store/recording";

/** An open file in the grid: name, where it lives, and its first lines. */
function FileTile({ id, home, showHost = false }: { id: string; home?: string | null; showHost?: boolean }) {
  const file = useEditor((s) => s.files[id]);
  const r = useRedact();
  if (!file) return null;
  const open = () => useEditor.getState().setActive(id);
  return (
    <article
      data-file={file.path}
      onClick={open}
      className={`tile group relative cursor-pointer overflow-hidden rounded-xl border ${file.conflict !== undefined ? "border-ember-400/50" : "border-sky-400/25"}`}
    >
      <header className="flex h-10 items-center gap-2.5 px-3">
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-sky-400/10 text-sky-300">
          {file.kind === "image" ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] leading-tight font-medium text-mist-100">{r(file.name)}</span>
            {file.dirty && <span title="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ember-400" />}
          </div>
          <div className="truncate font-mono text-[10.5px] leading-tight text-mist-500">
            {showHost && <span className="text-mist-400">{r(hostLabel(file.host))} · </span>}
            {r(shortPath(parentPath(file.path), home))}
          </div>
        </div>
        <span className="shrink-0 rounded bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10.5px] text-sky-300/80 group-hover:hidden">file</span>
        <button
          title={file.dirty ? "Open it to save or discard changes first" : "Close file"}
          disabled={file.dirty}
          onClick={(e) => {
            e.stopPropagation();
            useEditor.getState().close(id);
          }}
          className="hidden rounded-md p-1 text-mist-400 hover:bg-ink-600 hover:text-mist-100 disabled:opacity-40 group-hover:block"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="relative mx-2 mb-2 aspect-[16/10] overflow-hidden rounded-lg bg-[#0e1119] px-2.5 py-2 ring-1 ring-black/40">
        {file.kind === "text" ? (
          <pre className="font-mono text-[9.5px] leading-[1.35] whitespace-pre text-mist-300">{r(file.preview)}</pre>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-mist-500">
            {file.kind === "loading" ? "Loading…" : file.kind === "image" ? "Image" : file.kind === "error" ? "Couldn't open" : "Can't be edited here"}
          </div>
        )}
        {file.conflict !== undefined && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-ink-950/85 to-transparent px-2 pt-6 pb-2">
            <span className="rounded-full bg-ember-400/15 px-2.5 py-1 text-[11px] font-semibold text-ember-300 ring-1 ring-ember-400/40">Changed on disk</span>
          </div>
        )}
      </div>
    </article>
  );
}

export default memo(FileTile);
