import {
  ArrowLeft,
  Bell,
  BellOff,
  BellRing,
  Columns2,
  EyeOff,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Power,
  Rows2,
  Search,
  SquareCode,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { hostLabel, shortPath } from "../lib/hosts";
import { paneTarget } from "../lib/layoutTree";
import { canOpenInVsCode, openInVsCode, useVsCode } from "../lib/openers";
import { displayTitle, isDirect, paneIdentity, paneWhere } from "../lib/panes";
import { keyLabel, wheelZoomLabel } from "../lib/platform";
import { useApp } from "../store/app";
import { isZoomed, toggleZoom, useLayout } from "../store/layout";
import { useRedact } from "../store/recording";
import { useUi } from "../store/ui";
import { useViewPrefs, zoom } from "../store/viewPrefs";
import { useTerminalSizing } from "../term/sizing";
import HarnessBadge, { harnessLabel, isAgent } from "./HarnessBadge";
import HotkeyBadge from "./HotkeyBadge";
import NotifyToggle, { canTrack } from "./NotifyToggle";
import PaneNameField, { renameHint } from "./PaneNameField";
import { PrefixHelp, PrefixPending, TmuxRenameField, usePrefixKeys } from "./PrefixKeys";
import ResizeGrip from "./ResizeGrip";
import SearchBar from "./SearchBar";
import SizeMenu from "./SizeMenu";
import TerminalView, { type TerminalHandle } from "./TerminalView";

export function HeaderIcon({ onClick, title, children, active = false }: { onClick(): void; title: string; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-lg p-1.5 transition-colors hover:bg-ink-700 hover:text-mist-100 ${active ? "text-sky-400" : "text-mist-400"}`}
    >
      {children}
    </button>
  );
}

interface Props {
  pane: PaneInfo;
  leafId: string;
  /** Other leaves share the window (a slim header). */
  split: boolean;
  focused: boolean;
  /** Another view shows this tmux window too: neither resizes it. */
  shared: boolean;
  /** Mod+Enter in the terminal: to the composer. */
  onCompose(): void;
}

/** A terminal pane in the window's layout: its header and the terminal. */
export default function PaneLeaf({ pane, leafId, split, focused, shared, onCompose }: Props) {
  const hosts = useApp((s) => s.hosts);
  const termRef = useRef<TerminalHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const home = hosts[pane.host]?.facts?.home;
  const vscode = useVsCode();
  const r = useRedact();
  const muted = useApp((s) => s.muted[pane.key] ?? false);
  const connected = hosts[pane.host]?.phase.phase === "connected";
  const direct = isDirect(pane);
  const ended = pane.ended !== null;
  const id = paneIdentity(pane);
  const fontPref = useViewPrefs((s) => s.prefs[id]?.fontSize);
  const maximized = useUi((s) => s.maximized);
  const zoomed = useLayout((s) => isZoomed(s, leafId, maximized));
  const focusSeq = useLayout((s) => s.focusSeq);
  const currentFont = () => termRef.current?.term?.options.fontSize ?? fontPref ?? 13;
  const cellSize = () => termRef.current?.cellSize() ?? null;
  const sizing = useTerminalSizing(pane, frameRef, cellSize, { zoomed, shared });
  const layout = useLayout.getState;

  const toggleMute = () => {
    useApp.getState().setMuted(pane.key, !muted);
    backend().then((b) => b.setPaneMuted(pane.key, !muted));
  };
  const toGrid = () => {
    useUi.getState().setMaximized(false);
    layout().toGrid();
  };
  const closeLeaf = () => (split ? layout().close(leafId) : toGrid());
  const dismiss = () => {
    backend().then((b) => b.terminatePane(pane.key, true));
    closeLeaf();
  };
  const keys = usePrefixKeys(pane, toGrid, () => toggleZoom(leafId));
  const openMenu = () => {
    const box = frameRef.current?.getBoundingClientRect();
    useApp.getState().setTileMenu({ pane, x: box ? box.right - 230 : 0, y: box ? box.top : 0 });
  };
  const endTmuxRename = () => {
    keys.setRenaming(null);
    termRef.current?.focus();
  };

  // Scrolled back into the history: a button back to the latest output.
  const [scrolledBack, setScrolledBack] = useState(false);
  useEffect(() => {
    const term = termRef.current?.term;
    if (!term) return;
    const check = () => setScrolledBack(term.buffer.active.viewportY < term.buffer.active.baseY);
    const subs = [term.onScroll(check), term.onWriteParsed(check)];
    check();
    return () => subs.forEach((s) => s.dispose());
  }, [pane.key]);

  // Focus moved here by a click elsewhere, a hotkey or a jump: into the terminal for shells
  // (agents get the composer, from the workspace).
  useEffect(() => {
    if (focused && !isAgent(pane.harness)) termRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq]);

  const textSize = (
    <div className="mr-1 flex items-center rounded-lg ring-1 ring-ink-700">
      <HeaderIcon onClick={() => zoom(id, currentFont(), -1)} title={`Smaller text (${keyLabel("Mod+−")}, ${wheelZoomLabel})`}>
        <ZoomOut className="h-3.5 w-3.5" />
      </HeaderIcon>
      <button
        onClick={() => useViewPrefs.getState().setFontSize(id, null)}
        title={fontPref ? `Reset to auto-fit (${keyLabel("Mod+0")})` : "Text size fits the pane width"}
        className="min-w-10 px-1 text-center font-mono text-[11px] text-mist-400 hover:text-mist-100"
      >
        {fontPref ? `${fontPref}px` : "auto"}
      </button>
      <HeaderIcon onClick={() => zoom(id, currentFont(), 1)} title={`Larger text (${keyLabel("Mod+=")}, ${wheelZoomLabel})`}>
        <ZoomIn className="h-3.5 w-3.5" />
      </HeaderIcon>
    </div>
  );
  const splitButtons = (
    <>
      <HeaderIcon onClick={() => layout().place(leafId, "right", null)} title="Split right">
        <Columns2 className="h-3.5 w-3.5" />
      </HeaderIcon>
      <HeaderIcon onClick={() => layout().place(leafId, "bottom", null)} title="Split down">
        <Rows2 className="h-3.5 w-3.5" />
      </HeaderIcon>
    </>
  );
  const zoomButton = (
    <HeaderIcon onClick={() => toggleZoom(leafId)} title={zoomed ? (split ? "Restore the other splits" : "Restore side panels") : split ? "Maximize this split" : "Maximize (hide side panels)"}>
      {zoomed ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
    </HeaderIcon>
  );
  const title = renaming ? (
    <PaneNameField pane={pane} saveOnBlur onDone={() => setRenaming(false)} className="w-80 max-w-full py-0.5 text-[14px] font-semibold" />
  ) : (
    <div className="truncate text-[14.5px] font-semibold text-mist-100" title={`Double-click to rename. ${renameHint(pane)}`} onDoubleClick={() => setRenaming(true)}>
      {r(displayTitle(pane))}
    </div>
  );
  const where = (
    <>
      {harnessLabel(pane.harness)} · {r(hostLabel(pane.host))} ·{" "}
      {direct ? <span className="text-rose-300/80">{pane.currentCommand} · no tmux</span> : r(paneWhere(pane, true))} · {r(shortPath(pane.currentPath, home))}
    </>
  );

  return (
    <section className="relative flex h-full min-h-0 flex-col">
      {keys.help && keys.prefix && <PrefixHelp prefix={keys.prefix} onClose={() => keys.setHelp(false)} />}
      {split ? (
        <header className="flex h-9 shrink-0 items-center gap-2 pr-1">
          <HarnessBadge harness={pane.harness} size={20} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="min-w-0">{title}</div>
              <HotkeyBadge target={paneTarget(id)} />
            </div>
          </div>
          {keys.pending && keys.prefix && <PrefixPending prefix={keys.prefix} />}
          <SizeMenu pane={pane} sizing={sizing} zoom={{ on: zoomed, toggle: () => toggleZoom(leafId) }} />
          <HeaderIcon onClick={() => setSearching(true)} title={`Search (${keyLabel("Mod+F")})`}>
            <Search className="h-3.5 w-3.5" />
          </HeaderIcon>
          {splitButtons}
          {zoomButton}
          <HeaderIcon onClick={() => openMenu()} title="More">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </HeaderIcon>
          <HeaderIcon onClick={closeLeaf} title="Close this split (the pane keeps running)">
            <X className="h-3.5 w-3.5" />
          </HeaderIcon>
        </header>
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-3">
          <button
            onClick={toGrid}
            title={`Back to grid (${keyLabel("Mod+Shift+G")})`}
            className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <HarnessBadge harness={pane.harness} size={26} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <div className="min-w-0">{title}</div>
              <HotkeyBadge target={paneTarget(id)} />
            </div>
            {keys.renaming ? (
              <TmuxRenameField pane={pane} what={keys.renaming} onDone={endTmuxRename} />
            ) : (
              <div className="truncate font-mono text-[11px] text-mist-500">
                {where} · {pane.width}×{pane.height}
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {keys.pending && keys.prefix && <PrefixPending prefix={keys.prefix} />}
            <SizeMenu pane={pane} sizing={sizing} zoom={{ on: zoomed, toggle: () => toggleZoom(leafId) }} />
            {textSize}
            {canOpenInVsCode(vscode, pane.host) && pane.currentPath && (
              <HeaderIcon onClick={() => openInVsCode(pane.host, pane.currentPath)} title={`Open ${r(shortPath(pane.currentPath, home))} in VS Code`}>
                <SquareCode className="h-3.5 w-3.5" />
              </HeaderIcon>
            )}
            {splitButtons}
            {zoomButton}
            {canTrack(pane) && <NotifyToggle pane={pane} />}
            {pane.bellPings && (
              <span title="Pings when this pane rings the terminal bell (change it in ⋯)" className="p-1.5 text-sky-400">
                <BellRing className="h-3.5 w-3.5" />
              </span>
            )}
            <button
              onClick={toggleMute}
              title={muted ? "Unmute pings for this pane" : "Mute pings for this pane (it will still glow)"}
              className={`rounded-lg p-1.5 transition-colors hover:bg-ink-700 ${muted ? "text-ember-400" : "text-mist-400 hover:text-mist-100"}`}
            >
              {muted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
            </button>
            <HeaderIcon onClick={() => openMenu()} title="More: bell, labels, hotkey, notifications…">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </HeaderIcon>
            <button
              onClick={() => setSearching(true)}
              title={`Search (${keyLabel("Mod+F")})`}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100"
            >
              <Search className="h-3.5 w-3.5" /> Search
            </button>
            <button
              onClick={() => {
                backend().then((b) => b.setPaneHidden(pane.key, true));
                closeLeaf();
              }}
              title={direct ? "Hide from dashboard (keeps running)" : "Hide from dashboard (keeps running in tmux)"}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100"
            >
              <EyeOff className="h-3.5 w-3.5" /> Hide
            </button>
            {ended ? (
              <button
                onClick={dismiss}
                title="Remove this ended shell"
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100"
              >
                <X className="h-3.5 w-3.5" /> Dismiss
              </button>
            ) : (
              <button
                onClick={() => useApp.getState().setTerminating(pane.key)}
                title={direct ? "Hang up this shell" : "Quit the agent and close the tmux pane"}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-rose-400/10 hover:text-rose-400"
              >
                <Power className="h-3.5 w-3.5" /> Close
              </button>
            )}
          </div>
        </header>
      )}

      <div
        ref={frameRef}
        className={`scroll-thin relative min-h-0 flex-1 overflow-auto rounded-xl bg-[#0e1119] p-3 ring-1 ${
          direct ? "ring-rose-500/40" : split && focused ? "ring-sky-400/45" : "ring-ink-700"
        }`}
        onMouseDown={() => setTimeout(() => termRef.current?.focus(), 0)}
      >
        <TerminalView
          ref={termRef}
          pane={pane}
          onSearch={() => setSearching(true)}
          onBack={toGrid}
          autoFocus={focused && !isAgent(pane.harness)}
          onCompose={onCompose}
          fontSize={sizing.fontSize}
          raw={direct}
          prefix={direct ? null : keys.prefix}
          onPrefixKey={keys.onKey}
          onPrefixPending={keys.setPending}
        >
          {sizing.effective !== "scale" && (
            <ResizeGrip cols={pane.width} rows={pane.height} cellSize={cellSize} onResize={(cols, rows) => sizing.setMode("fixed", { cols, rows })} />
          )}
        </TerminalView>
        {sizing.resizedElsewhere && (
          <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center overflow-hidden rounded-full bg-ember-400/15 text-[11.5px] font-medium text-ember-300 ring-1 ring-ember-400/40 backdrop-blur">
            <button onClick={sizing.refit} className="py-1 pr-2 pl-3 hover:bg-ember-400/25" title="Resize it to fit this window again">
              Resized elsewhere · fit again
            </button>
            <button
              onClick={sizing.acknowledge}
              className="border-l border-ember-400/30 px-2 py-1 hover:bg-ember-400/25"
              title="Keep the new size (this goes away until it's resized elsewhere again)"
              aria-label="Dismiss: keep the new size"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {searching && (
          <SearchBar
            search={termRef.current?.search ?? null}
            onClose={() => {
              setSearching(false);
              termRef.current?.focus();
            }}
          />
        )}
        {ended && (
          <div className="sticky top-0 left-0 z-10 mb-2 flex items-center gap-3 rounded-lg bg-rose-950/85 px-3 py-2 text-[12px] text-rose-100 ring-1 ring-rose-500/40 backdrop-blur">
            <span className="min-w-0 flex-1">
              <span className="font-semibold">Session ended</span> · {r(pane.ended ?? "")}. Its output stays readable here; plain shells are never
              revived.
            </span>
            <button onClick={dismiss} className="shrink-0 rounded-md bg-rose-400/15 px-2.5 py-1 font-medium ring-1 ring-rose-400/40 hover:bg-rose-400/25">
              Dismiss
            </button>
          </div>
        )}
        {!connected && !direct && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-950/40 backdrop-blur-[1px]">
            <span className="rounded-full bg-ink-800/90 px-3 py-1 text-[12px] text-mist-300 ring-1 ring-ink-600">Reconnecting…</span>
          </div>
        )}
      </div>
      {scrolledBack && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            termRef.current?.term?.scrollToBottom();
            termRef.current?.focus();
          }}
          title="Back to the latest output"
          className="absolute right-4 bottom-4 z-10 rounded-full bg-ink-700/90 px-3 py-1.5 text-[12px] text-mist-100 shadow-lg ring-1 ring-ink-600 backdrop-blur hover:bg-ink-600"
        >
          Latest ↓
        </button>
      )}
    </section>
  );
}
