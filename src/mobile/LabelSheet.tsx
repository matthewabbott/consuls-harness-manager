// A pane's labels, from its ⋯ menu: tap to add or remove one, or make a new one for it.

import { Check, Plus, Tag } from "lucide-react";
import { useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { resolveLabels } from "../lib/labels";
import { useApp } from "../store/app";
import LabelForm from "./LabelForm";
import { Sheet, SheetAction } from "./Sheet";

export default function LabelSheet({ pane, onClose }: { pane: PaneInfo; onClose(): void }) {
  const defs = useApp((s) => s.config.labels);
  const [creating, setCreating] = useState(false);
  // Shown at once, until the pane's labels change on the machine (ours arriving, or another
  // device's): a quick second tap builds on the first.
  const [pending, setPending] = useState<{ base: string; labels: string[] } | null>(null);
  const base = pane.labels.join(",");
  const labels = pending?.base === base ? pending.labels : pane.labels;
  const set = (next: string[]) => {
    setPending({ base, labels: next });
    void backend().then((b) => b.setPaneLabels(pane.key, next));
  };
  const toggle = (id: string) => set(labels.includes(id) ? labels.filter((l) => l !== id) : [...labels, id]);
  // Ids on the pane that no device defines any more: shown, so they can be taken off.
  const unknown = resolveLabels(labels, defs).filter((l) => l.unknown);

  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-1 text-[12px] font-medium tracking-wide text-mist-500 uppercase">
        <Tag className="h-3 w-3" /> Labels
      </div>
      {[...defs, ...unknown].map((l) => (
        <SheetAction key={l.id} onClick={() => toggle(l.id)}>
          <Tag className="h-5 w-5 shrink-0" style={{ color: l.color }} />
          <span className={`min-w-0 flex-1 truncate ${"unknown" in l ? "text-mist-500" : ""}`}>{l.name}</span>
          {labels.includes(l.id) && <Check className="h-5 w-5 shrink-0 text-jade-400" />}
        </SheetAction>
      ))}
      {defs.length === 0 && !creating && <p className="px-3 py-2 text-[14px] leading-snug text-mist-400">Labels group panes across machines, on every device.</p>}
      {creating ? (
        <div className="px-3">
          <LabelForm onDone={() => setCreating(false)} onCreated={(l) => set([...labels, l.id])} />
        </div>
      ) : (
        <SheetAction onClick={() => setCreating(true)}>
          <Plus className="h-5 w-5 text-mist-400" /> New label…
        </SheetAction>
      )}
    </Sheet>
  );
}
