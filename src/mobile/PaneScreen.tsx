import { ALargeSmall, Bell, ChevronLeft, Copy, Eye, EyeOff, Keyboard, Minus, MoreHorizontal, Pencil, Plus, Power, Search, X } from "lucide-react";
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
import { NOTIFY_MODES, setNotifyMode } from "../lib/notifyModes";
import { displayTitle, isDirect, paneIdentity } from "../lib/panes";
import { useApp } from "../store/app";
import { FONT, useViewPrefs } from "../store/viewPrefs";
import KeyBar, { afterUse, heldMods, type Holds, nextHold, NO_HOLDS } from "./KeyBar";
import { Sheet, SheetAction } from "./Sheet";
import CopySheet from "./CopySheet";
import FindBar, { type FindResult } from "./FindBar";
import LinkSheet from "./LinkSheet";
import { MATCH_DECORATIONS } from "../term/find";
import type { TappedLink } from "../term/linkAt";

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
  const [copying, setCopying] = useState(false);
  const [link, setLink] = useState<TappedLink | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FindResult | null>(null);
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

  // Touch: two fingers pinch (scale the picture while they move, then settle on that text size;
  // the tmux window keeps its size, Fit adopts it). One finger dragging up or down scrolls: the
  // frame around the terminal first, then the terminal's own history (its scrollback, which a
  // touch doesn't scroll by itself), with momentum after a flick. Sideways stays the browser's.
  useEffect(() => {
    const frame = frameRef.current!;
    const zoomEl = zoomRef.current!;
    let pinch: { dist: number; font: number } | null = null;
    let scale = 1;
    let drag: { x: number; y: number; lastY: number; lastT: number; axis: "x" | "y" | null; v: number } | null = null;
    let lines = 0; // a fraction of a row, carried over
    let glide = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    /** Scrolls by `px` (positive: towards the latest). Returns whether there's more that way. */
    const scrollBy = (px: number): boolean => {
      const term = termRef.current?.term;
      const cell = termRef.current?.cellSize();
      if (!term || !cell) return false;
      const buf = term.buffer.active;
      if (px < 0) {
        // Up: the frame first, then into the history.
        const take = Math.min(frame.scrollTop, -px);
        frame.scrollTop -= take;
        px += take;
        if (px < 0) {
          lines += px / cell.height;
          const n = Math.trunc(lines);
          if (n) term.scrollLines(n);
          lines -= n;
        }
        return frame.scrollTop > 0 || buf.viewportY > 0;
      }
      if (buf.viewportY < buf.baseY) {
        // Down: back through the history to the latest, then the frame.
        lines += px / cell.height;
        const n = Math.min(Math.trunc(lines), buf.baseY - buf.viewportY);
        if (n) term.scrollLines(n);
        lines -= n;
      } else {
        frame.scrollTop += px;
      }
      return buf.viewportY < buf.baseY || frame.scrollTop + frame.clientHeight < frame.scrollHeight - 1;
    };

    const onStart = (e: TouchEvent) => {
      cancelAnimationFrame(glide);
      if (e.touches.length === 2) {
        drag = null;
        pinch = { dist: dist(e.touches), font: termRef.current?.term?.options.fontSize ?? 10 };
        scale = 1;
        const r = zoomEl.getBoundingClientRect();
        const x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        const y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        zoomEl.style.transformOrigin = `${x}px ${y}px`;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        drag = { x: t.clientX, y: t.clientY, lastY: t.clientY, lastT: e.timeStamp, axis: null, v: 0 };
        lines = 0;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation(); // not a scroll
        scale = Math.min(FONT.max / pinch.font, Math.max(MIN_FONT / pinch.font, dist(e.touches) / pinch.dist));
        zoomEl.style.transform = `scale(${scale})`;
        return;
      }
      if (!drag || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!drag.axis) {
        const dx = Math.abs(t.clientX - drag.x);
        const dy = Math.abs(t.clientY - drag.y);
        if (dx < 6 && dy < 6) return;
        drag.axis = dy > dx ? "y" : "x";
      }
      if (drag.axis !== "y") return;
      e.preventDefault();
      e.stopPropagation(); // the terminal's own handlers get nothing of it
      const dy = drag.lastY - t.clientY;
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag.v = 0.8 * (dy / dt) + 0.2 * drag.v;
      drag.lastY = t.clientY;
      drag.lastT = e.timeStamp;
      scrollBy(dy);
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        zoomEl.style.transform = "";
        if (Math.abs(scale - 1) > 0.04) useViewPrefs.getState().setFontSize(id, pinch.font * scale, MIN_FONT);
        pinch = null;
        return;
      }
      if (drag?.axis === "y" && e.touches.length === 0) {
        // A flick carries on, slowing down.
        let v = drag.v * 16; // px per frame
        const step = () => {
          if (Math.abs(v) < 0.5 || !scrollBy(v)) return;
          v *= 0.95;
          glide = requestAnimationFrame(step);
        };
        glide = requestAnimationFrame(step);
      }
      drag = null;
    };
    const noPageZoom = (e: Event) => e.preventDefault();
    frame.addEventListener("touchstart", onStart, { capture: true, passive: true });
    frame.addEventListener("touchmove", onMove, { capture: true, passive: false });
    frame.addEventListener("touchend", onEnd, { capture: true });
    frame.addEventListener("touchcancel", onEnd, { capture: true });
    frame.addEventListener("gesturestart", noPageZoom);
    return () => {
      cancelAnimationFrame(glide);
      frame.removeEventListener("touchstart", onStart, { capture: true });
      frame.removeEventListener("touchmove", onMove, { capture: true });
      frame.removeEventListener("touchend", onEnd, { capture: true });
      frame.removeEventListener("touchcancel", onEnd, { capture: true });
      frame.removeEventListener("gesturestart", noPageZoom);
    };
  }, [id]);

  // Scrolled back into the history: a button back to the latest.
  const [scrolledBack, setScrolledBack] = useState(false);
  useEffect(() => {
    const term = termRef.current?.term;
    if (!term) return;
    const check = () => setScrolledBack(term.buffer.active.viewportY < term.buffer.active.baseY);
    const subs = [term.onScroll(check), term.onWriteParsed(check)];
    return () => subs.forEach((s) => s.dispose());
  }, [pane.key]);

  // Find: xterm's search add-on scrolls the terminal to the match (and selects it); the frame
  // then scrolls too when the keyboard has made it smaller than the terminal.
  const showMatch = () => {
    const term = termRef.current?.term;
    const cell = termRef.current?.cellSize();
    const frame = frameRef.current;
    const at = term?.getSelectionPosition();
    if (!term || !cell || !frame || !at) return;
    const top = (at.start.y - term.buffer.active.viewportY) * cell.height;
    if (top < frame.scrollTop) frame.scrollTop = top;
    else if (top + cell.height + PAD_Y > frame.scrollTop + frame.clientHeight) frame.scrollTop = top + cell.height + PAD_Y - frame.clientHeight;
    const left = at.start.x * cell.width;
    if (left < frame.scrollLeft || left + cell.width > frame.scrollLeft + frame.clientWidth) frame.scrollLeft = Math.max(0, left - frame.clientWidth / 3);
  };
  const findOpts = { decorations: MATCH_DECORATIONS };
  const findOlder = () => {
    if (query && termRef.current?.search?.findPrevious(query, findOpts)) showMatch();
  };
  const findNewer = () => {
    if (query && termRef.current?.search?.findNext(query, findOpts)) showMatch();
  };
  useEffect(() => {
    const search = termRef.current?.search;
    if (!finding || !search) return;
    const sub = search.onDidChangeResults((r) => setFound(r ? { index: r.resultIndex, count: r.resultCount } : null));
    return () => {
      sub.dispose();
      search.clearDecorations();
      termRef.current?.term?.clearSelection();
      setFound(null);
    };
  }, [finding, pane.key]);
  useEffect(() => {
    const search = termRef.current?.search;
    if (!finding || !search) return;
    if (!query) {
      search.clearDecorations();
      termRef.current?.term?.clearSelection();
      setFound(null);
      return;
    }
    // From the latest backwards, growing the current match as the query grows.
    if (search.findPrevious(query, { ...findOpts, incremental: true })) showMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, query, pane.key]);

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
      // (While finding, the match rather than the cursor.)
      if (frame.clientHeight < height) (termRef.current?.term?.hasSelection() ? showMatch : reveal)();
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
        {finding ? (
          <div className="flex min-h-[44px] min-w-0 flex-1 items-center pl-1">
            <FindBar query={query} onQuery={setQuery} result={found} onOlder={findOlder} onNewer={findNewer} onClose={() => setFinding(false)}>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setCopying(true)} aria-label="Copy text" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
                <Copy className="h-5 w-5" />
              </button>
            </FindBar>
          </div>
        ) : (
          <>
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
            <div className="flex shrink-0 items-center">
              <button onClick={() => setFinding(true)} aria-label="Find" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
                <Search className="h-5 w-5" />
              </button>
              <button onClick={() => setCopying(true)} aria-label="Copy text" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
                <Copy className="h-5 w-5" />
              </button>
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
            </div>
          </>
        )}
      </header>
      {menu === "actions" && (
        <Sheet onClose={() => setMenu(null)}>
          {canTrack(pane) && (
            <div className="mb-1 border-b border-ink-700 pb-1">
              <div className="flex items-center gap-1.5 px-3 pt-1 pb-1 text-[12px] font-medium tracking-wide text-mist-500 uppercase">
                <Bell className="h-3 w-3" /> Notify
              </div>
              {NOTIFY_MODES.map((m) => (
                <SheetAction key={m.label} onClick={() => setNotifyMode(pane.key, m.mode)}>
                  <span className={`h-4 w-4 shrink-0 rounded-full ring-2 ${pane.notify === m.mode ? "bg-jade-400 ring-jade-400" : "ring-ink-600"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15.5px]">{m.label}</span>
                    <span className="block text-[12.5px] text-mist-500">{m.hint}</span>
                  </span>
                </SheetAction>
              ))}
            </div>
          )}
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
      {copying && termRef.current?.term && (
        <CopySheet term={termRef.current.term} pane={pane} query={finding ? query : ""} onClose={() => setCopying(false)} />
      )}
      {link && <LinkSheet link={link} onClose={() => setLink(null)} />}

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

      <div className="relative flex min-h-0 flex-1 flex-col">
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
              onLink={setLink}
              onModsUsed={() => setHolds((h) => ({ ctrl: afterUse(h.ctrl), alt: afterUse(h.alt) }))}
            />
          </div>
          {!connected && !direct && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink-950/40">
              <span className="rounded-full bg-ink-800/90 px-3 py-1 text-[13px] text-mist-300 ring-1 ring-ink-600">Reconnecting…</span>
            </div>
          )}
        </div>
        {scrolledBack && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => termRef.current?.term?.scrollToBottom()}
            className="absolute right-3 bottom-3 z-10 rounded-full bg-ink-700/90 px-3.5 py-2 text-[13px] text-mist-100 shadow-lg ring-1 ring-ink-600 backdrop-blur active:bg-ink-600"
          >
            Latest ↓
          </button>
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
