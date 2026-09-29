import {
  ArrowLeft,
  Bell,
  BellOff,
  BellRing,
  EyeOff,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Power,
  Search,
  SquareCode,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { backend } from "../ipc/backend";
import { useMemo, useRef, useState } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { hostLabel, shortPath } from "../lib/hosts";
import { canOpenInVsCode, openInVsCode, useVsCode } from "../lib/openers";
import { useApp } from "../store/app";
import { COMPOSER, FILMSTRIP, useUi } from "../store/ui";
import { useRedact } from "../store/recording";
import { isDirect, paneIdentity, paneWhere } from "../lib/panes";
import { useViewPrefs, zoom } from "../store/viewPrefs";
import { useAttachmentsOf } from "../store/attachments";
import ResizeHandle from "./ResizeHandle";
import Composer, { type ComposerHandle } from "./Composer";
import HarnessBadge, { harnessLabel, isAgent } from "./HarnessBadge";
import { displayTitle } from "./MiniTile";
import MiniTile from "./MiniTile";
import PaneNameField, { renameHint } from "./PaneNameField";
import { PrefixHelp, PrefixPending, TmuxRenameField, usePrefixKeys } from "./PrefixKeys";
import QuickKeys from "./QuickKeys";
import SearchBar from "./SearchBar";
import TerminalView, { type TerminalHandle } from "./TerminalView";
import ResizeGrip from "./ResizeGrip";
import SizeMenu from "./SizeMenu";
import { useTerminalSizing } from "../term/sizing";

function HeaderIcon({ onClick, title, children }: { onClick(): void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100">
      {children}
    </button>
  );
}

export default function ExpandedPane({ pane }: { pane: PaneInfo }) {
  const setExpanded = useApp((s) => s.setExpanded);
  const panes = useApp((s) => s.panes);
  const hosts = useApp((s) => s.hosts);
  const termRef = useRef<TerminalHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [searching, setSearching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const home = hosts[pane.host]?.facts?.home;
  const vscode = useVsCode();
  const r = useRedact();
  const muted = useApp((s) => s.muted[pane.key] ?? false);
  const toggleMute = () => {
    useApp.getState().setMuted(pane.key, !muted);
    backend().then((b) => b.setPaneMuted(pane.key, !muted));
  };
  const connected = hosts[pane.host]?.phase.phase === "connected";
  const direct = isDirect(pane);
  const ended = pane.ended !== null;
  const dismiss = () => {
    backend().then((b) => b.terminatePane(pane.key, true));
    back();
  };
  const filmstripWidth = useUi((s) => s.filmstripWidth);
  const filmstripCollapsed = useUi((s) => s.filmstripCollapsed);
  const maximized = useUi((s) => s.maximized);
  const composerHeight = useUi((s) => s.composerHeight);
  const attachments = useAttachmentsOf(paneIdentity(pane));
  const ui = useUi.getState;
  const id = paneIdentity(pane);
  const fontPref = useViewPrefs((s) => s.prefs[id]?.fontSize);
  const currentFont = () => termRef.current?.term?.options.fontSize ?? fontPref ?? 13;
  const cellSize = () => termRef.current?.cellSize() ?? null;
  const sizing = useTerminalSizing(pane, frameRef, cellSize);
  const waitingElsewhere = useApp(
    (s) => Object.values(s.attention).filter((a) => a.key !== pane.key && a.attention === "unacked").length,
  );

  const others = useMemo(
    () =>
      Object.values(panes)
        .flat()
        .filter((p) => p.key !== pane.key && !p.hidden),
    [panes, pane.key],
  );

  const back = () => {
    ui().setMaximized(false);
    setExpanded(null);
  };
  const showFilmstrip = others.length > 0 && !filmstripCollapsed && !maximized;
  const keys = usePrefixKeys(pane, back);
  const endTmuxRename = () => {
    keys.setRenaming(null);
    termRef.current?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1">
      <section className="relative flex min-w-0 flex-1 flex-col px-5 pb-4">
        {keys.help && keys.prefix && <PrefixHelp prefix={keys.prefix} onClose={() => keys.setHelp(false)} />}
        <header className="flex h-12 shrink-0 items-center gap-3">
          <button
            onClick={back}
            title="Back to grid (Ctrl+Shift+G)"
            className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <HarnessBadge harness={pane.harness} size={26} />
          <div className="min-w-0">
            {renaming ? (
              <PaneNameField pane={pane} saveOnBlur onDone={() => setRenaming(false)} className="w-80 max-w-full py-0.5 text-[14px] font-semibold" />
            ) : (
              <div
                className="truncate text-[14.5px] font-semibold text-mist-100"
                title={`Double-click to rename. ${renameHint(pane)}`}
                onDoubleClick={() => setRenaming(true)}
              >
                {r(displayTitle(pane))}
              </div>
            )}
            {keys.renaming ? (
              <TmuxRenameField pane={pane} what={keys.renaming} onDone={endTmuxRename} />
            ) : (
              <div className="truncate font-mono text-[11px] text-mist-500">
                {harnessLabel(pane.harness)} · {r(hostLabel(pane.host))} ·{" "}
                {direct ? <span className="text-rose-300/80">{pane.currentCommand} · no tmux</span> : r(paneWhere(pane, true))} ·{" "}
                {r(shortPath(pane.currentPath, home))} · {pane.width}×{pane.height}
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {keys.pending && keys.prefix && <PrefixPending prefix={keys.prefix} />}
            <SizeMenu pane={pane} sizing={sizing} />
            <div className="mr-1 flex items-center rounded-lg ring-1 ring-ink-700">
              <HeaderIcon onClick={() => zoom(id, currentFont(), -1)} title="Smaller text (Ctrl+−, Ctrl+wheel)">
                <ZoomOut className="h-3.5 w-3.5" />
              </HeaderIcon>
              <button
                onClick={() => useViewPrefs.getState().setFontSize(id, null)}
                title={fontPref ? "Reset to auto-fit (Ctrl+0)" : "Text size fits the pane width"}
                className="min-w-10 px-1 text-center font-mono text-[11px] text-mist-400 hover:text-mist-100"
              >
                {fontPref ? `${fontPref}px` : "auto"}
              </button>
              <HeaderIcon onClick={() => zoom(id, currentFont(), 1)} title="Larger text (Ctrl+=, Ctrl+wheel)">
                <ZoomIn className="h-3.5 w-3.5" />
              </HeaderIcon>
            </div>
            {canOpenInVsCode(vscode, pane.host) && pane.currentPath && (
              <HeaderIcon onClick={() => openInVsCode(pane.host, pane.currentPath)} title={`Open ${r(shortPath(pane.currentPath, home))} in VS Code`}>
                <SquareCode className="h-3.5 w-3.5" />
              </HeaderIcon>
            )}
            <HeaderIcon
              onClick={() => ui().setMaximized(!maximized)}
              title={maximized ? "Restore side panels" : "Maximize (hide side panels)"}
            >
              {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </HeaderIcon>
            <button
              onClick={() => backend().then((b) => b.setPaneBell(pane.key, !pane.bellPings))}
              title={
                pane.bellPings
                  ? "Pinging when this pane rings the terminal bell (click to stop)"
                  : "Ping when this pane rings the terminal bell — e.g. IRC highlights (on by default for irssi and weechat)"
              }
              className={`rounded-lg p-1.5 transition-colors hover:bg-ink-700 ${pane.bellPings ? "text-sky-400" : "text-mist-500 hover:text-mist-100"}`}
            >
              <BellRing className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={toggleMute}
              title={muted ? "Unmute pings for this pane" : "Mute pings for this pane (it will still glow)"}
              className={`rounded-lg p-1.5 transition-colors hover:bg-ink-700 ${muted ? "text-ember-400" : "text-mist-400 hover:text-mist-100"}`}
            >
              {muted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={() => setSearching(true)}
              title="Search (Ctrl+F)"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100"
            >
              <Search className="h-3.5 w-3.5" /> Search
            </button>
            <button
              onClick={() => {
                backend().then((b) => b.setPaneHidden(pane.key, true));
                back();
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

        <div
          ref={frameRef}
          className={`scroll-thin relative min-h-0 flex-1 overflow-auto rounded-xl bg-[#0e1119] p-3 ring-1 ${direct ? "ring-rose-500/40" : "ring-ink-700"}`}
          onMouseDown={() => setTimeout(() => termRef.current?.focus(), 0)}
        >
          <TerminalView
            ref={termRef}
            pane={pane}
            onSearch={() => setSearching(true)}
            onBack={back}
            autoFocus={!isAgent(pane.harness)}
            onCompose={() => composerRef.current?.focus()}
            fontSize={sizing.fontSize}
            raw={direct}
            prefix={direct ? null : keys.prefix}
            onPrefixKey={keys.onKey}
            onPrefixPending={keys.setPending}
          >
            {sizing.effective !== "scale" && (
              <ResizeGrip
                cols={pane.width}
                rows={pane.height}
                cellSize={cellSize}
                onResize={(cols, rows) => sizing.setMode("fixed", { cols, rows })}
              />
            )}
          </TerminalView>
          {sizing.resizedElsewhere && (
            <button
              onClick={sizing.refit}
              className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ember-400/15 px-3 py-1 text-[11.5px] font-medium text-ember-300 ring-1 ring-ember-400/40 backdrop-blur hover:bg-ember-400/25"
            >
              Resized elsewhere · fit again
            </button>
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
        <div className={`mt-2.5 flex shrink-0 items-center gap-3 ${ended ? "pointer-events-none opacity-40" : ""}`}>
          <QuickKeys paneKey={pane.key} harness={pane.harness} />
          <span className="ml-auto text-[11px] text-mist-500">
            Click the terminal to type into it directly · Ctrl+F search · Ctrl+Shift+G grid
          </span>
        </div>
        <ResizeHandle
          axis="y"
          size={composerHeight}
          direction={-1}
          onResize={(h) => ui().setComposerHeight(h)}
          resetTo={COMPOSER.default}
          className="mt-0.5"
        />
        {/* Pasted images get their own row on top of the text. */}
        <div className={`shrink-0 ${ended ? "pointer-events-none opacity-40" : ""}`} style={{ height: composerHeight + (attachments.length ? 60 : 0) }}>
          <Composer
            ref={composerRef}
            pane={pane}
            onEscapeEmpty={() => backend().then((b) => b.sendKeys(pane.key, ["Escape"]))}
          />
        </div>
      </section>

      {showFilmstrip && (
        <ResizeHandle
          axis="x"
          size={filmstripWidth}
          direction={-1}
          onResize={(w) => ui().setFilmstripWidth(w)}
          resetTo={FILMSTRIP.default}
          className="-mr-1.5"
        />
      )}
      {showFilmstrip && (
        <aside style={{ width: filmstripWidth }} className="flex shrink-0 flex-col border-l border-ink-700/80">
          <div className="flex h-12 shrink-0 items-center gap-1.5 px-2">
            <HeaderIcon onClick={() => ui().toggleFilmstrip()} title="Hide other panes">
              <PanelRightClose className="h-3.5 w-3.5" />
            </HeaderIcon>
            <span className="text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">Other panes</span>
            <span className="font-mono text-[10.5px] text-mist-600">{others.length}</span>
          </div>
          <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
            {others.map((p) => (
              <MiniTile
                key={p.key}
                pane={p}
                compact
                stale={hosts[p.host]?.phase.phase === "connected" ? null : "Offline"}
                home={hosts[p.host]?.facts?.home}
              />
            ))}
          </div>
        </aside>
      )}
      {others.length > 0 && filmstripCollapsed && !maximized && (
        <aside className="flex w-10 shrink-0 justify-center border-l border-ink-700/80">
          <div className="flex h-12 items-center">
            <HeaderIcon
              onClick={() => ui().toggleFilmstrip()}
              title={waitingElsewhere > 0 ? `Show other panes (${waitingElsewhere} waiting)` : "Show other panes"}
            >
              <span className="relative block">
                <PanelRightOpen className="h-3.5 w-3.5" />
                {waitingElsewhere > 0 && <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-ember-400 ring-2 ring-ink-900" />}
              </span>
            </HeaderIcon>
          </div>
        </aside>
      )}
    </div>
  );
}
