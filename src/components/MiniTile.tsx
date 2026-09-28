import { EyeOff, Lock, Power, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { hostLabel, shortPath } from "../lib/hosts";
import { useApp } from "../store/app";
import { beginTileDrag, consumeJustDragged } from "../store/drag";
import { resolveLabels } from "../lib/labels";
import { isDirect, paneName, paneWhere } from "../lib/panes";
import { paintTile } from "../term/tilePainter";
import { getTile, subscribeTile } from "../term/tiles";
import HarnessBadge from "./HarnessBadge";

/** Strip the status glyph some harnesses prefix to their terminal title. */
function cleanTitle(title: string): string {
  return title.replace(/^[✳✻✶✢·◐◑◒◓⠀-⣿*•]+\s*/u, "").trim();
}

export function displayTitle(p: PaneInfo): string {
  const t = cleanTitle(p.title);
  // Shells title themselves with the host, user@host:path, or (Windows) their exe path /
  // `MINGW64:/…`; none of those beat the folder.
  const noise = /^[\w.-]+@[\w.-]+:/.test(t) || /^[A-Za-z]:[\\/]/.test(t) || /^MINGW(32|64):/.test(t);
  if (t && t !== p.host && !t.startsWith(p.host + ":") && !noise) return t;
  if (p.harness === "shell" || p.harness === null) return shortPath(p.currentPath);
  return paneName(p);
}

interface Props {
  pane: PaneInfo;
  stale: string | null;
  home?: string | null;
  /** Smaller variant for the filmstrip beside the expanded view. */
  compact?: boolean;
  /** Show the machine name (when the grid isn't grouped by machine). */
  showHost?: boolean;
}

function MiniTile({ pane, stale, home, compact = false, showHost = false }: Props) {
  const setExpanded = useApp((s) => s.setExpanded);
  const labelDefs = useApp((s) => s.config.labels);
  const labels = resolveLabels(pane.labels, labelDefs);
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
    if (consumeJustDragged()) return;
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
      paintTile(canvas, getTile(pane.key), stale !== null || pane.ended !== null);
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
  }, [pane.key, stale, pane.ended]);

  const title = displayTitle(pane);
  const where = paneWhere(pane);
  const direct = isDirect(pane);
  const sized = pane.tmux?.sized ?? false;
  // Direct panes don't reconnect: they're either live or ended (never "stale").
  const overlay = direct ? (pane.ended ? "Ended" : null) : stale;
  const dismiss = () => backend().then((b) => b.terminatePane(pane.key, true));

  return (
    <article
      onClick={open}
      onPointerDown={(e) =>
        beginTileDrag(e, pane.key, title, (labelId) => {
          if (!pane.labels.includes(labelId)) backend().then((b) => b.setPaneLabels(pane.key, [...pane.labels, labelId]));
        })
      }
      onContextMenu={(e) => {
        e.preventDefault();
        useApp.getState().setTileMenu({ pane, x: e.clientX, y: e.clientY });
      }}
      className={`tile group relative cursor-pointer overflow-hidden rounded-xl border ${direct ? "border-rose-500/35" : "border-ink-700/70"} ${glow}`}
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
          {!compact && (
            <div className="truncate font-mono text-[10.5px] leading-tight text-mist-500">
              {showHost && <span className="text-mist-400">{hostLabel(pane.host)} · </span>}
              {shortPath(pane.currentPath, home)}
            </div>
          )}
        </div>
        {!compact && (
          <>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] group-hover:hidden ${direct ? "bg-rose-500/10 text-rose-300/80" : "bg-ink-700/80 text-mist-400"}`}
              title={
                direct
                  ? `Plain shell without tmux · ${pane.width}×${pane.height} · lost if the connection drops`
                  : `${pane.tmux?.paneId} · ${pane.width}×${pane.height}${sized ? " · size pinned by Harness Manager" : ""}`
              }
            >
              {sized && <Lock className="mr-1 inline h-2.5 w-2.5 align-[-1px]" />}
              {where}
            </span>
            <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
              {pane.ended ? (
                <TileAction title="Dismiss" onClick={dismiss}>
                  <X className="h-3.5 w-3.5" />
                </TileAction>
              ) : (
                <>
                  <TileAction title="Hide from dashboard (keeps running)" onClick={() => backend().then((b) => b.setPaneHidden(pane.key, true))}>
                    <EyeOff className="h-3.5 w-3.5" />
                  </TileAction>
                  <TileAction title={direct ? "Close shell…" : "Quit & close…"} danger onClick={() => useApp.getState().setTerminating(pane.key)}>
                    <Power className="h-3.5 w-3.5" />
                  </TileAction>
                </>
              )}
            </div>
          </>
        )}
      </header>
      {labels.length > 0 && !compact && (
        <div className="-mt-0.5 flex flex-wrap gap-1 px-3 pb-1.5">
          {labels.map((l) => (
            <span
              key={l.id}
              title={l.unknown ? "Unknown label (deleted elsewhere?)" : l.name}
              className={`flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium ${l.unknown ? "text-mist-500" : "text-mist-200"}`}
              style={{ background: `${l.color}22`, boxShadow: `inset 0 0 0 1px ${l.color}55` }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
              {l.name}
            </span>
          ))}
        </div>
      )}
      <div className={`relative overflow-hidden rounded-lg bg-[#0e1119] ring-1 ring-black/40 ${compact ? "mx-1.5 mb-1.5 aspect-[16/9]" : "mx-2 mb-2 aspect-[16/10]"}`}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {waiting && !overlay && (
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
        {overlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-950/30 backdrop-blur-[1px]">
            <span
              title={pane.ended ?? undefined}
              className={`rounded-full px-3 py-1 text-[11px] font-medium ring-1 ${direct ? "bg-rose-950/80 text-rose-200 ring-rose-500/40" : "bg-ink-800/90 text-mist-300 ring-ink-600"}`}
            >
              {direct ? `Ended · ${pane.ended}` : overlay}
            </span>
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
