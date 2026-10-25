// Settings → Labels: make, rename, recolour, delete and reorder labels. They're shared with your
// other devices through your machines.

import { GripVertical, Plus, Tag, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { backend } from "../ipc/backend";
import { movesIt, moveToGap } from "../lib/reorder";
import { useLabelOrder } from "../lib/useLabelOrder";
import { useApp } from "../store/app";
import { beginReorderDrag } from "../store/drag";
import LabelForm from "./LabelForm";

/** Where a dragged label would land. */
function InsertLine({ at }: { at: "top" | "bottom" }) {
  return <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-ember-400 ${at === "top" ? "-top-px" : "-bottom-px"}`} />;
}

export default function LabelSettings() {
  const [labels, reorder] = useLabelOrder();
  const panes = useApp((s) => s.panes);
  // The label being edited ("new": a new one), or asked about deleting.
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; gap: number } | null>(null);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of Object.values(panes).flat()) for (const l of p.labels) c[l] = (c[l] ?? 0) + 1;
    return c;
  }, [panes]);
  const ids = labels.map((l) => l.id);
  const line = (gap: number) => drag !== null && drag.gap === gap && movesIt(ids, drag.id, gap);

  const startDrag = (e: React.PointerEvent, id: string) => {
    setDeleting(null);
    beginReorderDrag(
      e,
      e.currentTarget.closest("section"),
      (gap) => setDrag(gap === null ? null : { id, gap }),
      (gap) => {
        if (movesIt(ids, id, gap)) reorder(moveToGap(ids, id, gap));
      },
      3,
    );
  };

  return (
    <>
      {labels.map((l, i) =>
        editing === l.id ? (
          <div key={l.id} data-reorder={l.id} className="px-4">
            <LabelForm label={l} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <div key={l.id} data-reorder={l.id} className={`relative flex items-center pr-2 ${drag?.id === l.id ? "bg-ink-700/70" : ""}`}>
            {line(i) && <InsertLine at="top" />}
            <span role="button" aria-label={`Move ${l.name}`} onPointerDown={(e) => startDrag(e, l.id)} className="shrink-0 touch-none px-2.5 py-3.5 text-mist-500">
              <GripVertical className="h-5 w-5" />
            </span>
            <button onClick={() => setEditing(l.id)} className="flex min-w-0 flex-1 items-center gap-2.5 py-3 text-left active:opacity-70">
              <Tag className="h-4.5 w-4.5 shrink-0" style={{ color: l.color }} />
              <span className="min-w-0 truncate text-[15px] text-mist-100">{l.name}</span>
              <span className="ml-auto shrink-0 pr-1 text-[13px] text-mist-500">{counts[l.id] ? `${counts[l.id]} pane${counts[l.id] === 1 ? "" : "s"}` : ""}</span>
            </button>
            {deleting === l.id ? (
              <>
                <button
                  onClick={() => {
                    setDeleting(null);
                    void backend().then((b) => b.deleteLabel(l.id));
                  }}
                  className="rounded-lg bg-rose-400/15 px-3 py-1.5 text-[14px] font-medium text-rose-400 active:bg-rose-400/25"
                >
                  Delete
                </button>
                <button onClick={() => setDeleting(null)} aria-label="Keep it" className="rounded-lg p-2 text-mist-400 active:bg-ink-700">
                  <X className="h-4.5 w-4.5" />
                </button>
              </>
            ) : (
              <button onClick={() => setDeleting(l.id)} aria-label={`Delete ${l.name}`} className="rounded-lg p-2 text-mist-500 active:bg-ink-700">
                <Trash2 className="h-4.5 w-4.5" />
              </button>
            )}
            {i === labels.length - 1 && line(labels.length) && <InsertLine at="bottom" />}
          </div>
        ),
      )}
      {editing === "new" ? (
        <div className="px-4">
          <LabelForm onDone={() => setEditing(null)} />
        </div>
      ) : (
        <button onClick={() => setEditing("new")} className="flex w-full items-center gap-2 px-4 py-3 text-[15px] text-ember-400 active:bg-ink-700">
          <Plus className="h-4 w-4" /> New label
        </button>
      )}
      <p className="px-4 py-3 text-[13px] leading-snug text-mist-500">
        Labels group panes across machines. They're shared with your other devices through your machines{labels.length > 1 ? "; drag ⋮⋮ to reorder them" : ""}.
      </p>
    </>
  );
}
