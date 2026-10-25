import { FileText, X } from "lucide-react";
import { useMemo } from "react";

import { fileTarget, leaves, paneTarget } from "../lib/layoutTree";
import { hostLabel } from "../lib/hosts";
import { displayTitle, paneIdentity } from "../lib/panes";
import { useApp } from "../store/app";
import { useEditor } from "../store/editor";
import { useLayout } from "../store/layout";
import { useRedact } from "../store/recording";
import HarnessBadge from "./HarnessBadge";

/** A new split: pick a pane or an open file for it. */
export default function PickerLeaf({ leafId }: { leafId: string }) {
  const panes = useApp((s) => s.panes);
  const files = useEditor((s) => s.files);
  const order = useEditor((s) => s.order);
  const root = useLayout((s) => s.root);
  const r = useRedact();
  const shown = useMemo(() => new Set(leaves(root).map((l) => l.target)), [root]);
  const paneList = Object.values(panes)
    .flat()
    .filter((p) => !p.hidden && !shown.has(paneTarget(paneIdentity(p))));
  const fileList = order.filter((id) => files[id] && !shown.has(fileTarget(id)));
  const fill = (target: string) => useLayout.getState().fill(leafId, target);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-ink-900/60 ring-1 ring-sky-400/30">
      <header className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="flex-1 text-[12px] font-semibold text-mist-300">Show here…</span>
        <button
          onClick={() => useLayout.getState().close(leafId)}
          title="Close this split"
          className="rounded-lg p-1 text-mist-400 hover:bg-ink-700 hover:text-mist-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {paneList.length === 0 && fileList.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-mist-500">Everything open is already on screen. Drag a tile here from the grid or the side strip.</p>
        )}
        {paneList.map((p) => (
          <button
            key={p.key}
            onClick={() => fill(paneTarget(paneIdentity(p)))}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-ink-700"
          >
            <HarnessBadge harness={p.harness} size={20} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-mist-100">{r(displayTitle(p))}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-mist-500">{r(hostLabel(p.host))}</span>
          </button>
        ))}
        {fileList.map((id) => (
          <button key={id} onClick={() => fill(fileTarget(id))} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-ink-700">
            <FileText className="h-4 w-4 shrink-0 text-sky-400/80" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-mist-100">{r(files[id].name)}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-mist-500">{r(hostLabel(files[id].host))}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
