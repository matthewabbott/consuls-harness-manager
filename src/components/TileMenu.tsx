import { BellRing, Check, EyeOff, FolderSearch, Maximize2, Pencil, Plus, Power, Smartphone, SquareCode, Tag, Keyboard } from "lucide-react";
import { useEffect, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { isLocal } from "../lib/hosts";
import { canOpenInVsCode, openInVsCode, REVEAL_LABEL, revealPath, useVsCode } from "../lib/openers";
import { useApp } from "../store/app";
import { paneIdentity } from "../lib/panes";
import { digitOf, useHotkeys } from "../store/hotkeys";
import { assignLabel, jumpLabel } from "../lib/hotkeys";
import { paneTarget } from "../lib/layoutTree";
import { LabelEditor } from "./LabelsPanel";
import { NOTIFY_MODES, setNotifyMode } from "../lib/notifyModes";
import { canTrack } from "./NotifyToggle";
import PaneNameField, { renameHint } from "./PaneNameField";

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
  const [renaming, setRenaming] = useState(false);
  const vscode = useVsCode();

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
        <HotkeyRow target={paneTarget(paneIdentity(pane))} />
        {renaming ? (
          <div className="px-1.5 py-1">
            <PaneNameField pane={pane} onDone={onClose} className="w-full text-[12.5px]" />
            <div className="px-0.5 pt-1 text-[10.5px] leading-snug text-mist-500">
              {renameHint(pane)} Enter saves; empty for the automatic name.
            </div>
          </div>
        ) : (
          <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setRenaming(true)}>
            Rename…
          </MenuItem>
        )}
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
        {pane.currentPath && (isLocal(pane.host) || canOpenInVsCode(vscode, pane.host)) && (
          <>
            <div className="my-1 h-px bg-ink-700" />
            {isLocal(pane.host) && (
              <MenuItem icon={<FolderSearch className="h-3.5 w-3.5" />} onClick={() => { revealPath(pane.host, pane.currentPath); onClose(); }}>
                {REVEAL_LABEL}
              </MenuItem>
            )}
            {canOpenInVsCode(vscode, pane.host) && (
              <MenuItem icon={<SquareCode className="h-3.5 w-3.5" />} onClick={() => { openInVsCode(pane.host, pane.currentPath); onClose(); }}>
                Open folder in VS Code
              </MenuItem>
            )}
          </>
        )}
        <div className="my-1 h-px bg-ink-700" />
        {canTrack(pane) && (
          <>
            <div className="flex items-center gap-2 px-2.5 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-mist-500 uppercase">
              <Smartphone className="h-3 w-3" /> Push to phone
            </div>
            {NOTIFY_MODES.map((m) => (
              <MenuItem key={m.label} icon={<span className="block w-3.5" />} onClick={() => setNotifyMode(pane.key, m.mode)}>
                <span className="flex-1" title={m.hint}>
                  {m.label}
                </span>
                {pane.notify === m.mode && <Check className="h-3.5 w-3.5 text-jade-400" />}
              </MenuItem>
            ))}
            <div className="my-1 h-px bg-ink-700" />
          </>
        )}
        <BellRow pane={pane} />
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

/** Digits 1–9: the one that jumps to `target` lit; a click gives it (or takes it back). */
function HotkeyRow({ target }: { target: string }) {
  const keys = useHotkeys((s) => s.keys);
  const mine = digitOf(keys, target);
  return (
    <div className="flex items-center gap-0.5 px-2.5 py-1" title={`Jump here with ${jumpLabel(mine ?? 1)}…; ${assignLabel(1)}… gives the focused split a key`}>
      <Keyboard className="mr-1.5 h-3.5 w-3.5 shrink-0 text-mist-500" />
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
        <button
          key={d}
          onClick={() => useHotkeys.getState().assign(d, target)}
          title={mine === d ? `Remove ${jumpLabel(d)}` : keys[d] ? `${jumpLabel(d)} (moves it here)` : jumpLabel(d)}
          className={`h-5 w-5 rounded font-mono text-[10.5px] ${mine === d ? "bg-sky-400/90 text-ink-950" : keys[d] ? "text-mist-400 hover:bg-ink-700" : "text-mist-500 hover:bg-ink-700 hover:text-mist-200"}`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

/** Whether the pane's terminal bell pings: by default (on for chat clients like irssi), on, or off. */
function BellRow({ pane }: { pane: PaneInfo }) {
  const set = (bell: boolean | null) => backend().then((b) => b.setPaneBell(pane.key, bell));
  const chat = /^(irssi|weechat)$/.test(pane.currentCommand);
  const options: [string, boolean | null, string][] = [
    ["Auto", null, chat ? "On, as for chat clients" : "Off, as for most programs"],
    ["On", true, "Ping when this pane rings the terminal bell"],
    ["Off", false, "Never ping for this pane's bell"],
  ];
  return (
    <div
      className="flex items-center gap-1 px-2.5 py-1"
      title={chat ? "irssi rings for what its beep_msg_level says (normally highlights and private messages); /set beep_msg_level HILIGHT MSGS keeps it to those" : undefined}
    >
      <BellRing className={`mr-1.5 h-3.5 w-3.5 shrink-0 ${pane.bellPings ? "text-sky-400" : "text-mist-500"}`} />
      <span className="flex-1 text-[12.5px] text-mist-200">Bell</span>
      {options.map(([label, value, hint]) => (
        <button
          key={label}
          onClick={() => set(value)}
          title={hint}
          className={`rounded px-1.5 py-0.5 text-[11px] ${pane.bell === value ? "bg-sky-400/90 text-ink-950" : "text-mist-400 hover:bg-ink-700 hover:text-mist-100"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
