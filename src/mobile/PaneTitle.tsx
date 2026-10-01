// The pane's name in the phone's header. Tapped, it takes the header's width so a long name shows
// whole; tapped again, it's renamed in place (in Consuls only: tmux's own names stay). An empty
// name, or the automatic title itself, goes back to the automatic title.

import { Pencil, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { displayTitle } from "../lib/panes";

export type TitleMode = "short" | "full" | "rename";

interface Props {
  pane: PaneInfo;
  /** The line under the name (status · where). */
  subtitle: React.ReactNode;
  mode: TitleMode;
  onMode(mode: TitleMode): void;
}

export default function PaneTitle({ pane, subtitle, mode, onMode }: Props) {
  const box = useRef<HTMLButtonElement>(null);
  // Shown whole, a tap anywhere else shrinks it back.
  useEffect(() => {
    if (mode !== "full") return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onMode("short");
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [mode, onMode]);

  if (mode === "rename") return <RenameField pane={pane} onDone={() => onMode("short")} />;
  const full = mode === "full";
  return (
    <button
      ref={box}
      onClick={() => onMode(full ? "rename" : "full")}
      aria-label={full ? "Rename" : "Show the whole name"}
      className="ml-1.5 flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
    >
      <div className="min-w-0 flex-1">
        <div className={`text-[15px] font-semibold text-mist-100 ${full ? "line-clamp-3 break-words" : "truncate"}`}>{displayTitle(pane)}</div>
        <div className={`text-[12px] ${full ? "break-words" : "truncate"}`}>{subtitle}</div>
      </div>
      {full && <Pencil className="mr-2 h-4 w-4 shrink-0 text-mist-500" />}
    </button>
  );
}

function RenameField({ pane, onDone }: { pane: PaneInfo; onDone(): void }) {
  const auto = displayTitle({ ...pane, name: null });
  const [value, setValue] = useState(pane.name ?? auto);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return; // Enter, then the blur it causes
    finished.current = true;
    const name = value.trim();
    const next = name && name !== auto ? name : null;
    if (save && next !== (pane.name ?? null)) void backend().then((b) => b.renamePane(pane.key, next));
    onDone();
  };
  // Buttons keep the field focused (a blur would save).
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="ml-1 flex min-w-0 flex-1 items-center gap-1">
      <label className="flex min-w-0 flex-1 items-center rounded-xl bg-ink-800 pl-2.5 ring-1 ring-ember-400/50">
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={auto}
          aria-label="Name"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[16px] font-semibold text-mist-100 outline-none placeholder:font-normal placeholder:text-mist-500"
        />
        {value && (
          <button onMouseDown={keepFocus} onClick={() => setValue("")} aria-label="Clear the name" className="p-2 text-mist-500 active:text-mist-200">
            <X className="h-4 w-4" />
          </button>
        )}
      </label>
      <button onMouseDown={keepFocus} onClick={() => finish(true)} className="rounded-full px-2 py-1.5 text-[15px] font-medium text-ember-400 active:bg-ink-700">
        Save
      </button>
    </div>
  );
}
