import { Check, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { backend } from "../ipc/backend";
import type { LabelDef } from "../ipc/bindings/LabelDef";
import { LABEL_COLORS, nextColor } from "../lib/labels";
import { useApp } from "../store/app";
import { useDrag } from "../store/drag";

/** Sidebar section: labels like folders, with counts; click to filter, drop a tile to tag it. */
export default function LabelsPanel() {
  const labels = useApp((s) => s.config.labels);
  const panes = useApp((s) => s.panes);
  const focusLabel = useApp((s) => s.focusLabel);
  const [creating, setCreating] = useState(false);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of Object.values(panes).flat()) for (const l of p.labels) c[l] = (c[l] ?? 0) + 1;
    return c;
  }, [panes]);

  return (
    <div>
      <div className="flex items-center justify-between pr-1">
        <div className="px-2.5 pt-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">Labels</div>
        <button onClick={() => setCreating(true)} title="New label" className="rounded p-1 text-mist-500 hover:text-mist-200">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-0.5">
        {labels.map((l) => (
          <LabelRow key={l.id} label={l} count={counts[l.id] ?? 0} active={focusLabel === l.id} />
        ))}
        {creating && <LabelEditor onDone={() => setCreating(false)} />}
        {labels.length === 0 && !creating && (
          <p className="px-2.5 text-[11.5px] leading-relaxed text-mist-500">
            Tag panes to group them across machines. Create a label, then drop tiles on it or right-click a tile.
          </p>
        )}
      </div>
    </div>
  );
}

function LabelRow({ label, count, active }: { label: LabelDef; count: number; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const over = useDrag((s) => s.over === label.id);

  if (editing) return <LabelEditor label={label} onDone={() => setEditing(false)} />;
  return (
    <div
      data-label-drop={label.id}
      onClick={() => useApp.getState().setFocusLabel(active ? null : label.id)}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors ${
        over ? "bg-sky-400/15 ring-1 ring-sky-400/50" : active ? "bg-ink-700/80" : "hover:bg-ink-750"
      }`}
    >
      <Tag className="h-3.5 w-3.5 shrink-0" style={{ color: label.color }} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-mist-200">{label.name}</span>
      <span className="font-mono text-[10.5px] text-mist-500 group-hover:hidden">{count}</span>
      <div className="hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setEditing(true)} title="Rename" className="rounded p-0.5 text-mist-500 hover:text-mist-100">
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => {
            if (confirm(`Delete label “${label.name}”? It's removed from ${count} pane${count === 1 ? "" : "s"}; the panes themselves are untouched.`)) {
              backend().then((b) => b.deleteLabel(label.id));
              if (useApp.getState().focusLabel === label.id) useApp.getState().setFocusLabel(null);
            }
          }}
          title="Delete label"
          className="rounded p-0.5 text-mist-500 hover:text-rose-400"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export function LabelEditor({ label, onDone, onCreated }: { label?: LabelDef; onDone(): void; onCreated?(l: LabelDef): void }) {
  const labels = useApp((s) => s.config.labels);
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? nextColor(labels));
  const save = async () => {
    if (!name.trim()) return onDone();
    const b = await backend();
    if (label) await b.updateLabel({ ...label, name: name.trim(), color });
    else {
      // (Not `onCreated?.(await …)`: an absent callback would skip evaluating the argument.)
      const created = await b.createLabel(name.trim(), color);
      onCreated?.(created);
    }
    onDone();
  };
  return (
    <form
      className="space-y-2 rounded-lg bg-ink-750 px-2.5 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onDone()}
          placeholder="Label name"
          className="min-w-0 flex-1 rounded-md bg-ink-900 px-2 py-1 text-[12px] text-mist-100 ring-1 ring-ink-600 outline-none focus:ring-sky-400/60"
        />
        <button type="submit" title="Save" className="rounded p-1 text-jade-400 hover:bg-ink-700">
          <Check className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onDone} title="Cancel" className="rounded p-1 text-mist-500 hover:bg-ink-700">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex gap-1.5">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-ink-750 ${c === color ? "ring-2 ring-mist-100" : ""}`}
            style={{ background: c }}
          />
        ))}
      </div>
    </form>
  );
}
