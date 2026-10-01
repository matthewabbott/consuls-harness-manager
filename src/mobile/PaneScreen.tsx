import { ALargeSmall, Bell, ChevronLeft, Eye, EyeOff, Keyboard, Minus, MoreHorizontal, Pencil, Plus, Power, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import Composer, { type ComposerHandle } from "../components/Composer";
import { isAgent } from "../components/HarnessBadge";
import { canTrack, notifyTitle, toggleNotify } from "../components/NotifyToggle";
import { PrefixHelp, PrefixPending, TmuxRenameField, usePrefixKeys } from "../components/PrefixKeys";
import QuickKeys from "../components/QuickKeys";
import TerminalView, { type TerminalHandle } from "../components/TerminalView";
import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { HARNESS_DOT, HARNESS_NAME, status } from "../lib/agents";
import { displayTitle, isDirect, paneIdentity } from "../lib/panes";
import { useApp } from "../store/app";
import { FONT, useViewPrefs } from "../store/viewPrefs";
import KeyBar, { afterUse, heldMods, type Holds, nextHold, NO_HOLDS } from "./KeyBar";
import { Sheet, SheetAction } from "./Sheet";

/** Names the pane (in Consuls only: tmux's own names stay); empty clears it. */
function RenameSheet({ pane, onClose }: { pane: PaneInfo; onClose(): void }) {
  const [value, setValue] = useState(pane.name ?? "");
  const save = (name: string | null) => {
    void backend().then((b) => b.renamePane(pane.key, name));
    onClose();
  };
  return (
    <Sheet onClose={onClose}>
      <div className="px-1 pb-2">
        <div className="mb-2 text-[13px] text-mist-400">Name this {pane.harness && pane.harness !== "shell" ? "agent" : "pane"}</div>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save(value.trim() || null)}
          placeholder={displayTitle({ ...pane, name: null })}
          className="w-full rounded-xl bg-ink-800 px-3.5 py-3 text-[16px] text-mist-100 ring-1 ring-ink-700 outline-none focus:ring-ember-400/60"
        />
        <div className="mt-3 flex gap-2">
          {pane.name && (
            <button onClick={() => save(null)} className="rounded-xl px-4 py-3 text-[15px] text-mist-400 active:bg-ink-700">
              Clear
            </button>
          )}
          <button onClick={() => save(value.trim() || null)} className="flex-1 rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80">
            Save
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** Zoomed out, the phone goes smaller than the desktop's floor. */
const MIN_FONT = 5;
/** The terminal frame's padding (px-1.5, py-1), and a little slack. */
const PAD_X = 14;
const PAD_Y = 10;

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

function SizeButton({ onClick, label, children }: { onClick(): void; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} className="flex h-9 min-w-9 items-center justify-center rounded-lg bg-ink-800 px-2.5 text-[14px] text-mist-200 ring-1 ring-ink-700 active:bg-ink-600">
      {children}
    </button>
  );
}

/**
 * One agent or shell: its terminal, keys, and the composer (iOS dictation works in it).
 * Sizing: a pinch zooms the text only (wider than the screen, it scrolls sideways); A−/A+ change
 * the text size and resize the tmux window to fit the phone; Fit resizes it at the size shown;
 * Reset hands the size back to tmux.
 */
export default function PaneScreen({ pane, onBack }: { pane: PaneInfo; onBack(): void }) {
  const termRef = useRef<TerminalHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const id = paneIdentity(pane);
  const fontPref = useViewPrefs((s) => s.prefs[id]?.fontSize ?? null);
  const connected = useApp((s) => s.hosts[pane.host]?.phase.phase === "connected");
  const att = useApp((s) => s.attention[pane.key]);
  // The web app's server is `@local`.
  const where = useApp((s) => (pane.host === "@local" ? (s.tailnet?.selfNode?.id ?? "this machine") : pane.host));
  const st = status(att);
  const harness = pane.harness ?? "shell";
  const direct = isDirect(pane);
  const ended = pane.ended !== null;
  const [sizeBar, setSizeBar] = useState(false);
  const [keyBar, setKeyBar] = useState(!isAgent(pane.harness));
  const [holds, setHolds] = useState<Holds>(NO_HOLDS);
  const [typing, setTyping] = useState(false);
  const [menu, setMenu] = useState<"actions" | "rename" | null>(null);
  const keys = usePrefixKeys(pane, onBack);

  const renderedFont = () => termRef.current?.term?.options.fontSize ?? fontPref ?? 10;

  /** Resizes the tmux window so the pane fills the screen at the text size shown. */
  const fitWindow = async () => {
    await frames(2); // a font change has been drawn: measure its cells
    const frame = frameRef.current;
    const cell = termRef.current?.cellSize();
    if (!frame || !cell) return;
    const cols = Math.max(20, Math.floor((frame.clientWidth - PAD_X) / cell.width));
    const rows = Math.max(5, Math.floor((frame.clientHeight - PAD_Y) / cell.height));
    const now = useApp.getState().panes[pane.host]?.find((p) => p.key === pane.key);
    if (now && now.width === cols && now.height === rows) return;
    try {
      const outcome = await (await backend()).resizePane(pane.key, cols, rows);
      if (outcome.otherClients > 0 && !useViewPrefs.getState().prefs[id]?.warnedOthers) {
        useViewPrefs.getState().update(id, { warnedOthers: true });
        const n = outcome.otherClients;
        useApp.getState().notify("info", `Also open on ${n} other device${n === 1 ? "" : "s"}: they see it at the phone's size until you tap Reset.`, pane.host);
      }
    } catch (e) {
      useApp.getState().notify("warning", `Couldn't resize: ${e}`, pane.host);
    }
  };
  const zoomBy = (dir: 1 | -1) => {
    useViewPrefs.getState().setFontSize(id, renderedFont() + dir * FONT.step, MIN_FONT);
    void fitWindow();
  };
  const reset = () => {
    useViewPrefs.getState().setFontSize(id, null);
    void backend().then((b) => b.releasePaneSize(pane.key));
  };

  // Pinch: scale the picture while the fingers move, then settle on that text size. The tmux
  // window keeps its size (Fit adopts it).
  useEffect(() => {
    const frame = frameRef.current!;
    const zoomEl = zoomRef.current!;
    let start: { dist: number; font: number } | null = null;
    let scale = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      start = { dist: dist(e.touches), font: termRef.current?.term?.options.fontSize ?? 10 };
      scale = 1;
      const r = zoomEl.getBoundingClientRect();
      const x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
      const y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
      zoomEl.style.transformOrigin = `${x}px ${y}px`;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      e.stopPropagation(); // not a scroll
      scale = Math.min(FONT.max / start.font, Math.max(MIN_FONT / start.font, dist(e.touches) / start.dist));
      zoomEl.style.transform = `scale(${scale})`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length >= 2) return;
      zoomEl.style.transform = "";
      if (Math.abs(scale - 1) > 0.04) useViewPrefs.getState().setFontSize(id, start.font * scale, MIN_FONT);
      start = null;
    };
    const noPageZoom = (e: Event) => e.preventDefault();
    frame.addEventListener("touchstart", onStart, { capture: true, passive: true });
    frame.addEventListener("touchmove", onMove, { capture: true, passive: false });
    frame.addEventListener("touchend", onEnd, { capture: true });
    frame.addEventListener("touchcancel", onEnd, { capture: true });
    frame.addEventListener("gesturestart", noPageZoom);
    return () => {
      frame.removeEventListener("touchstart", onStart, { capture: true });
      frame.removeEventListener("touchmove", onMove, { capture: true });
      frame.removeEventListener("touchend", onEnd, { capture: true });
      frame.removeEventListener("touchcancel", onEnd, { capture: true });
      frame.removeEventListener("gesturestart", noPageZoom);
    };
  }, [id]);

  // The keyboard coming up shrinks the frame: keep the line being typed on in view. Typing into
  // the terminal shrinks the composer to one line, for room.
  useEffect(() => {
    const frame = frameRef.current!;
    const reveal = () => {
      const term = termRef.current?.term;
      const cell = termRef.current?.cellSize();
      if (!term || !cell) return;
      const bottom = (term.buffer.active.cursorY + 1) * cell.height + PAD_Y;
      if (bottom > frame.scrollTop + frame.clientHeight) frame.scrollTop = bottom - frame.clientHeight;
    };
    let height = frame.clientHeight;
    const ro = new ResizeObserver(() => {
      if (frame.clientHeight < height) reveal();
      height = frame.clientHeight;
    });
    ro.observe(frame);
    const textarea = termRef.current?.term?.textarea;
    const onFocus = () => {
      setTyping(true);
      setTimeout(reveal, 350); // after the keyboard's animation
    };
    const onBlur = () => setTyping(false);
    textarea?.addEventListener("focus", onFocus);
    textarea?.addEventListener("blur", onBlur);
    return () => {
      ro.disconnect();
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("blur", onBlur);
    };
  }, [pane.key]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {keys.help && keys.prefix && <PrefixHelp prefix={keys.prefix} onClose={() => keys.setHelp(false)} />}
      <header className="safe-top flex shrink-0 items-center gap-1 px-1.5 pb-1.5">
        <button onClick={onBack} aria-label="Back" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <ChevronLeft className="h-7 w-7" />
        </button>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${HARNESS_DOT[harness]}`} />
        <div className="ml-1.5 min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-mist-100">{displayTitle(pane)}</div>
          <div className="truncate text-[12px]">
            <span className={st.tone}>{st.text || HARNESS_NAME[harness]}</span>
            <span className="text-mist-500"> · {where}</span>
          </div>
        </div>
        {keys.pending && keys.prefix && <PrefixPending prefix={keys.prefix} />}
        <button
          onClick={() => setSizeBar(!sizeBar)}
          aria-label="Text and window size"
          aria-pressed={sizeBar}
          className={`rounded-full p-2 active:bg-ink-700 ${sizeBar ? "text-ember-400" : "text-mist-300"}`}
        >
          <ALargeSmall className="h-5.5 w-5.5" />
        </button>
        {canTrack(pane) && (
          <button
            onClick={() => toggleNotify(pane)}
            aria-pressed={pane.notify !== null}
            aria-label={notifyTitle(pane)}
            className={`rounded-full p-2 active:bg-ink-700 ${pane.notify !== null ? "text-jade-400" : "text-mist-500"}`}
          >
            <Bell className={`h-5 w-5 ${pane.notify !== null ? "fill-current" : ""}`} />
          </button>
        )}
        <button onClick={() => setMenu("actions")} aria-label="More" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
          <MoreHorizontal className="h-5.5 w-5.5" />
        </button>
      </header>
      {menu === "actions" && (
        <Sheet onClose={() => setMenu(null)}>
          <SheetAction onClick={() => setMenu("rename")}>
            <Pencil className="h-5 w-5 text-mist-400" /> Rename
          </SheetAction>
          {pane.hidden ? (
            <SheetAction
              onClick={() => {
                setMenu(null);
                void backend().then((b) => b.setPaneHidden(pane.key, false));
              }}
            >
              <Eye className="h-5 w-5 text-mist-400" /> Show in the list
            </SheetAction>
          ) : (
            <SheetAction
              onClick={() => {
                setMenu(null);
                void backend().then((b) => b.setPaneHidden(pane.key, true));
                onBack();
              }}
            >
              <EyeOff className="h-5 w-5 text-mist-400" /> Hide from the list
            </SheetAction>
          )}
          {ended ? (
            <SheetAction
              danger
              onClick={() => {
                setMenu(null);
                void backend().then((b) => b.terminatePane(pane.key, true));
                onBack();
              }}
            >
              <X className="h-5 w-5" /> Dismiss
            </SheetAction>
          ) : (
            <SheetAction
              danger
              onClick={() => {
                setMenu(null);
                useApp.getState().setTerminating(pane.key);
              }}
            >
              <Power className="h-5 w-5" /> {isAgent(pane.harness) ? "Quit the agent and close" : "Close"}
            </SheetAction>
          )}
        </Sheet>
      )}
      {menu === "rename" && <RenameSheet pane={pane} onClose={() => setMenu(null)} />}

      {keys.renaming && (
        <div className="shrink-0 px-3 pb-2">
          <TmuxRenameField pane={pane} what={keys.renaming} onDone={() => keys.setRenaming(null)} />
        </div>
      )}

      {sizeBar && (
        <div className="shrink-0 px-2 pb-2">
          <div className="flex items-center gap-1.5">
            <SizeButton onClick={() => zoomBy(-1)} label="Smaller text, resize to fit">
              <Minus className="h-4 w-4" />
            </SizeButton>
            <SizeButton onClick={() => zoomBy(1)} label="Larger text, resize to fit">
              <Plus className="h-4 w-4" />
            </SizeButton>
            <SizeButton onClick={() => void fitWindow()} label="Resize the window to fit at this text size">
              Fit
            </SizeButton>
            <SizeButton onClick={reset} label="Automatic text size; tmux decides the window size">
              Reset
            </SizeButton>
            <span className="ml-auto font-mono text-[12px] text-mist-500">
              {pane.width}×{pane.height} · {fontPref ? `${fontPref}px` : "auto"}
            </span>
          </div>
          <p className="mt-1.5 px-0.5 text-[11.5px] leading-snug text-mist-500">
            − and + resize the window to fit the phone. Pinch zooms the text only; Fit then resizes to match.
          </p>
        </div>
      )}

      <div ref={frameRef} className={`terminal-frame relative min-h-0 flex-1 overflow-auto bg-[#0e1119] px-1.5 py-1 ${direct ? "ring-1 ring-rose-500/40" : ""}`}>
        <div ref={zoomRef} className="inline-block origin-top-left">
          <TerminalView
            ref={termRef}
            pane={pane}
            onSearch={() => {}}
            onBack={onBack}
            autoFocus={false}
            onCompose={() => composerRef.current?.focus()}
            fontSize={fontPref}
            raw={direct}
            prefix={direct ? null : keys.prefix}
            onPrefixKey={keys.onKey}
            onPrefixPending={keys.setPending}
            heldMods={heldMods(holds)}
            onModsUsed={() => setHolds((h) => ({ ctrl: afterUse(h.ctrl), alt: afterUse(h.alt) }))}
          />
        </div>
        {!connected && !direct && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-950/40">
            <span className="rounded-full bg-ink-800/90 px-3 py-1 text-[13px] text-mist-300 ring-1 ring-ink-600">Reconnecting…</span>
          </div>
        )}
      </div>

      <div className={`safe-bottom shrink-0 space-y-2 border-t border-ink-700/80 px-2 pt-2 ${ended ? "pointer-events-none opacity-40" : ""}`}>
        {keyBar && (
          <KeyBar holds={holds} onHold={(mod) => setHolds((h) => ({ ...h, [mod]: nextHold(h[mod]) }))} onKey={(name) => termRef.current?.sendKey(name)} />
        )}
        <div className="flex items-center gap-1.5">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setKeyBar(!keyBar)}
            aria-label="Terminal keys: Ctrl, Alt, arrows, PgUp…"
            aria-pressed={keyBar}
            className={`shrink-0 rounded-lg p-2 ring-1 ${keyBar ? "bg-sky-400/15 text-sky-300 ring-sky-400/50" : "bg-ink-800 text-mist-300 ring-ink-700"}`}
          >
            <Keyboard className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <QuickKeys paneKey={pane.key} harness={pane.harness} touch />
          </div>
        </div>
        <div className="transition-[height]" style={{ height: typing ? 46 : 92 }}>
          <Composer ref={composerRef} pane={pane} returnSends={false} onEscapeEmpty={() => backend().then((b) => b.sendKeys(pane.key, ["Escape"]))} />
        </div>
      </div>
    </div>
  );
}
