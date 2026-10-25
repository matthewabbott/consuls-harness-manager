// Naming and colouring a label on the phone: in Settings → Labels, and in a pane's Labels sheet.

import { useState } from "react";

import { backend } from "../ipc/backend";
import type { LabelDef } from "../ipc/bindings/LabelDef";
import { LABEL_COLORS, nextColor } from "../lib/labels";
import { useApp } from "../store/app";

export default function LabelForm({ label, onDone, onCreated }: { label?: LabelDef; onDone(): void; onCreated?(l: LabelDef): void }) {
  const labels = useApp((s) => s.config.labels);
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? nextColor(labels));
  const save = async () => {
    if (!name.trim()) return;
    try {
      const b = await backend();
      if (label) await b.updateLabel({ ...label, name: name.trim(), color });
      else {
        const created = await b.createLabel(name.trim(), color);
        onCreated?.(created);
      }
      onDone();
    } catch (e) {
      useApp.getState().notify("error", `Couldn't save the label: ${e}`);
    }
  };
  return (
    <form
      className="space-y-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Label name"
        enterKeyHint="done"
        className="w-full rounded-xl bg-ink-900 px-3.5 py-2.5 text-[16px] text-mist-100 ring-1 ring-ink-600 outline-none focus:ring-ember-400/60"
      />
      <div className="flex flex-wrap gap-2.5 px-0.5">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Colour ${c}`}
            aria-pressed={c === color}
            onClick={() => setColor(c)}
            className={`h-7 w-7 rounded-full ${c === color ? "outline-2 outline-offset-2 outline-mist-100" : ""}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onDone} className="flex-1 rounded-xl bg-ink-700 py-2.5 text-[16px] text-mist-100 active:bg-ink-600">
          Cancel
        </button>
        <button type="submit" disabled={!name.trim()} className="flex-1 rounded-xl bg-ember-400 py-2.5 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-40">
          {label ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}
