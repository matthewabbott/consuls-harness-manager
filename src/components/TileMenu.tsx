import { Check, EyeOff, Maximize2, Plus, Power, Tag } from "lucide-react";
import { useEffect, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { useApp } from "../store/app";
import { LabelEditor } from "./LabelsPanel";

export interface TileMenuState {
  pane: PaneInfo;
  x: number;
  y: number;
}

/** Right-click menu for a tile: labels (toggle / create), open, hide, close. */
export default function TileMenu({ menu, onClose }: { menu: TileMenuState; onClose(): void }) {
  const labels = useApp((s) => s.config.labels);
  // Read the live pane so toggles reflect immediately.
  const pane = useApp((s) => Object.values(s.panes).flat().find((p) => p.key === menu.pane.key)) ?? menu.pane;
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string) => {
    const next = pane.labels.includes(id) ? pane.labels.filter((l) => l !== id) : [...pane.labels, id];
    backend().then((b) => b.setPaneLabels(pane.key, next));
  };

  // Keep the menu on screen.
  const left = Math.min(menu.x, window.innerWidth - 240);
  const top = Math.min(menu.y, window.innerHeight - 320);

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        className="animate-rise absolute w-56 rounded-xl bg-ink-800 p-1 shadow-2xl ring-1 ring-ink-600"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MenuItem icon={<Maximize2 className="h-3.5 w-3.5" />} onClick={() => { backend().then((b) => b.ackPane(pane.key)); useApp.getState().setExpanded(pane.key); onClose(); }}>
          Open
        </MenuItem>
        <div className="my-1 h-px bg-ink-700" />
        <div className="px-2.5 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-wide text-mist-500 uppercase">Labels</div>
        {labels.map((l) => (
          <MenuItem key={l.id} icon={<Tag className="h-3.5 w-3.5" style={{ color: l.color }} />} onClick={() => toggle(l.id)}>
            <span className="flex-1">{l.name}</span>
            {pane.labels.includes(l.id) && <Check className="h-3.5 w-3.5 text-sky-400" />}
          </MenuItem>
        ))}
        {creating ? (
          <div className="p-1">
            <LabelEditor onDone={() => setCreating(false)} onCreated={(l) => backend().then((b) => b.setPaneLabels(pane.key, [...pane.labels, l.id]))} />
          </div>
        ) : (
          <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
            New label…
          </MenuItem>
        )}
        <div className="my-1 h-px bg-ink-700" />
        <MenuItem icon={<EyeOff className="h-3.5 w-3.5" />} onClick={() => { backend().then((b) => b.setPaneHidden(pane.key, true)); onClose(); }}>
          Hide (keeps running)
        </MenuItem>
        <MenuItem icon={<Power className="h-3.5 w-3.5" />} danger onClick={() => { useApp.getState().setTerminating(pane.key); onClose(); }}>
          Quit &amp; close…
        </MenuItem>
      </div>
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-ink-700 ${danger ? "text-rose-400" : "text-mist-200"}`}
    >
      <span className="text-mist-400">{icon}</span>
      {children}
    </button>
  );
}
