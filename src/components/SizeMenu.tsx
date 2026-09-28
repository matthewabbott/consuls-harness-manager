import { Check, ChevronDown, Expand, Lock, Maximize2, RotateCcw, Scaling } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { useUi } from "../store/ui";
import type { Sizing } from "../term/sizing";

/** Header control: current size + how the tmux window is sized while expanded. */
export default function SizeMenu({ pane, sizing }: { pane: PaneInfo; sizing: Sizing }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const maximized = useUi((s) => s.maximized);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const label = { fit: "fit", fixed: "fixed", scale: "scaled" }[sizing.effective];
  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={pane.tmux ? "How this pane's tmux window is sized" : "Terminal size"}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] ring-1 transition-colors ${
          sizing.resizedElsewhere ? "text-ember-300 ring-ember-400/40" : "text-mist-300 ring-ink-700 hover:bg-ink-700"
        }`}
      >
        {pane.tmux?.sized && <Lock className="h-3 w-3 text-mist-500" />}
        {pane.width}×{pane.height}
        <span className="text-mist-500">· {label}</span>
        <ChevronDown className="h-3 w-3 text-mist-500" />
      </button>
      {open && (
        <div className="animate-rise absolute top-full right-0 z-30 mt-1 w-80 rounded-xl bg-ink-800 p-1.5 shadow-2xl ring-1 ring-ink-600">
          {sizing.resizedElsewhere && (
            <Item icon={<RotateCcw className="h-3.5 w-3.5 text-ember-400" />} title="Resized elsewhere — fit again" onClick={pick(sizing.refit)} />
          )}
          <Item
            icon={<Expand className="h-3.5 w-3.5" />}
            title="Auto-fit"
            hint="Resize the tmux window to fill this view, and keep it fitted"
            checked={sizing.mode === "fit" && !maximized}
            onClick={pick(() => sizing.setMode("fit"))}
          />
          <Item
            icon={<Lock className="h-3.5 w-3.5" />}
            title={`Keep ${pane.width}×${pane.height}`}
            hint="Remember this size (or drag the terminal's corner)"
            checked={sizing.mode === "fixed" && !maximized}
            onClick={pick(() => sizing.setMode("fixed", { cols: pane.width, rows: pane.height }))}
          />
          <Item
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            title={maximized ? "Restore side panels" : "Maximize"}
            hint="Hide the side panels and fit to the whole window"
            checked={maximized}
            onClick={pick(() => useUi.getState().setMaximized(!maximized))}
          />
          <Item
            icon={<Scaling className="h-3.5 w-3.5" />}
            title="Don't resize"
            hint="Leave tmux's size alone; scale the text to fit instead"
            checked={sizing.mode === "scale" && !maximized}
            onClick={pick(() => sizing.setMode("scale"))}
          />
          {pane.tmux?.sized && (
            <>
              <div className="my-1 h-px bg-ink-700" />
              <Item
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                title="Let tmux decide"
                hint="Give the window back to tmux's automatic sizing (other devices get their view back)"
                onClick={pick(sizing.release)}
              />
            </>
          )}
          {(pane.tmux?.windowPanes ?? 1) > 1 && (
            <p className="px-2.5 pt-1.5 pb-1 text-[10.5px] leading-snug text-mist-500">
              This pane shares its tmux window with {pane.tmux!.windowPanes - 1} other pane{pane.tmux!.windowPanes > 2 ? "s" : ""};
              resizing it resizes them too.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ icon, title, hint, checked, onClick }: { icon: React.ReactNode; title: string; hint?: string; checked?: boolean; onClick(): void }) {
  return (
    <button onClick={onClick} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-ink-700">
      <span className="mt-0.5 text-mist-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-mist-100">{title}</span>
        {hint && <span className="block text-[11px] leading-snug text-mist-500">{hint}</span>}
      </span>
      {checked && <Check className="mt-0.5 h-3.5 w-3.5 text-sky-400" />}
    </button>
  );
}
