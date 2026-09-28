import { EyeOff, Lock, Power } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { shortPath } from "../lib/hosts";
import { useApp } from "../store/app";
import { paintTile } from "../term/tilePainter";
import { getTile, subscribeTile } from "../term/tiles";
import HarnessBadge from "./HarnessBadge";

/** Strip the status glyph some harnesses prefix to their terminal title. */
function cleanTitle(title: string): string {
  return title.replace(/^[✳✻✶✢·◐◑◒◓⠀-⣿*•]+\s*/u, "").trim();
}

export function displayTitle(p: PaneInfo): string {
  const t = cleanTitle(p.title);
  if (t && t !== p.host && !t.startsWith(p.host + ":") && !/^[\w.-]+@[\w.-]+:/.test(t)) return t;
  if (p.harness === "shell" || p.harness === null) return shortPath(p.currentPath);
  return p.windowName;
}

interface Props {
  pane: PaneInfo;
  stale: string | null;
  home?: string | null;
  /** Smaller variant for the filmstrip beside the expanded view. */
  compact?: boolean;
}

function MiniTile({ pane, stale, home, compact = false }: Props) {
  const setExpanded = useApp((s) => s.setExpanded);
  const att = useApp((s) => s.attention[pane.key]);
  const [pulsing, setPulsing] = useState(false);
  const lastPulse = useRef(att?.pulse ?? 0);
  useEffect(() => {
    if (!att || att.pulse === lastPulse.current) return;
    lastPulse.current = att.pulse;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), 1100);
    return () => clearTimeout(t);
  }, [att?.pulse, att]);
  const waiting = att && (att.activity === "idle" || att.activity === "needsInput") && att.attention !== "none";
  const glow = att?.attention === "unacked" ? (att.activity === "needsInput" ? "glow-iris" : "glow-ember") : pulsing ? "pulse" : "";
  const open = () => {
    backend().then((b) => b.ackPane(pane.key));
    setExpanded(pane.key);
  };
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      paintTile(canvas, getTile(pane.key), stale !== null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    schedule();
    const unsubscribe = subscribeTile(pane.key, schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      unsubscribe();
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pane.key, stale]);

  const title = displayTitle(pane);
  const where = `${pane.sessionName}:${pane.windowIndex}${pane.paneIndex > 1 || !pane.paneActive ? `.${pane.paneIndex}` : ""}`;

  return (
    <article
      onClick={open}
      className={`tile group relative cursor-pointer overflow-hidden rounded-xl border border-ink-700/70 ${glow}`}
    >
      <header className={`flex items-center gap-2.5 ${compact ? "h-8 px-2.5" : "h-10 px-3"}`}>
        <HarnessBadge harness={pane.harness} size={compact ? 18 : 22} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[13px] leading-tight font-medium text-mist-100" title={pane.title || title}>
              {title}
            </div>
            {att?.activity === "working" && (
              <span title={att.source === "heuristic" ? "Working (guessed from output)" : "Working"} className="flex shrink-0 items-center gap-1 text-[10.5px] text-sky-400">
                <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-sky-400" />
                {!compact && "working"}
              </span>
            )}
          </div>
          {!compact && <div className="truncate font-mono text-[10.5px] leading-tight text-mist-500">{shortPath(pane.currentPath, home)}</div>}
        </div>
        {!compact && (
          <>
            <span
              className="shrink-0 rounded bg-ink-700/80 px-1.5 py-0.5 font-mono text-[10.5px] text-mist-400 group-hover:hidden"
              title={`${pane.paneId} · ${pane.width}×${pane.height}${pane.sized ? " · size pinned by Harness Manager" : ""}`}
            >
              {pane.sized && <Lock className="mr-1 inline h-2.5 w-2.5 align-[-1px]" />}
              {where}
            </span>
            <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
              <TileAction title="Hide from dashboard (keeps running)" onClick={() => backend().then((b) => b.setPaneHidden(pane.key, true))}>
                <EyeOff className="h-3.5 w-3.5" />
              </TileAction>
              <TileAction title="Quit & close…" danger onClick={() => useApp.getState().setTerminating(pane.key)}>
                <Power className="h-3.5 w-3.5" />
              </TileAction>
            </div>
          </>
        )}
      </header>
      <div className={`relative overflow-hidden rounded-lg bg-[#0e1119] ring-1 ring-black/40 ${compact ? "mx-1.5 mb-1.5 aspect-[16/9]" : "mx-2 mb-2 aspect-[16/10]"}`}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {waiting && !stale && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-ink-950/85 to-transparent px-2 pt-6 pb-2">
            <span
              className={`flex max-w-full items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 backdrop-blur ${
                att.activity === "needsInput"
                  ? "bg-iris-400/15 text-iris-300 ring-iris-400/40"
                  : "bg-ember-400/15 text-ember-300 ring-ember-400/40"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${att.activity === "needsInput" ? "bg-iris-400" : "bg-ember-400"}`} />
              <span className="truncate">{att.activity === "needsInput" ? (att.reason ?? "Needs your input") : "Waiting on you"}</span>
            </span>
          </div>
        )}
        {stale && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-950/30 backdrop-blur-[1px]">
            <span className="rounded-full bg-ink-800/90 px-3 py-1 text-[11px] font-medium text-mist-300 ring-1 ring-ink-600">{stale}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function TileAction({ title, onClick, danger, children }: { title: string; onClick(): void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded-md p-1 text-mist-400 transition-colors hover:bg-ink-600 ${danger ? "hover:text-rose-400" : "hover:text-mist-100"}`}
    >
      {children}
    </button>
  );
}

export default memo(MiniTile);
