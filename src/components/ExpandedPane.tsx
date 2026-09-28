import { ArrowLeft, Bell, BellOff, EyeOff, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Power, Search } from "lucide-react";

import { backend } from "../ipc/backend";
import { useMemo, useRef, useState } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { shortPath } from "../lib/hosts";
import { useApp } from "../store/app";
import { COMPOSER, FILMSTRIP, useUi } from "../store/ui";
import ResizeHandle from "./ResizeHandle";
import Composer, { type ComposerHandle } from "./Composer";
import HarnessBadge, { harnessLabel, isAgent } from "./HarnessBadge";
import { displayTitle } from "./MiniTile";
import MiniTile from "./MiniTile";
import QuickKeys from "./QuickKeys";
import SearchBar from "./SearchBar";
import TerminalView, { type TerminalHandle } from "./TerminalView";

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
  const composerRef = useRef<ComposerHandle>(null);
  const [searching, setSearching] = useState(false);
  const home = hosts[pane.host]?.facts?.home;
  const muted = useApp((s) => s.muted[pane.key] ?? false);
  const toggleMute = () => {
    useApp.getState().setMuted(pane.key, !muted);
    backend().then((b) => b.setPaneMuted(pane.key, !muted));
  };
  const connected = hosts[pane.host]?.phase.phase === "connected";
  const filmstripWidth = useUi((s) => s.filmstripWidth);
  const filmstripCollapsed = useUi((s) => s.filmstripCollapsed);
  const maximized = useUi((s) => s.maximized);
  const composerHeight = useUi((s) => s.composerHeight);
  const ui = useUi.getState;
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

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col px-5 pb-4">
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
            <div className="truncate text-[14.5px] font-semibold text-mist-100">{displayTitle(pane)}</div>
            <div className="truncate font-mono text-[11px] text-mist-500">
              {harnessLabel(pane.harness)} · {pane.host} · {pane.sessionName}:{pane.windowIndex}.{pane.paneIndex} ·{" "}
              {shortPath(pane.currentPath, home)} · {pane.width}×{pane.height}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <HeaderIcon
              onClick={() => ui().setMaximized(!maximized)}
              title={maximized ? "Restore side panels" : "Maximize (hide side panels)"}
            >
              {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </HeaderIcon>
            {others.length > 0 && !maximized && (
              <HeaderIcon onClick={() => ui().toggleFilmstrip()} title={filmstripCollapsed ? "Show other panes" : "Hide other panes"}>
                <span className="relative">
                  {filmstripCollapsed ? <PanelRightOpen className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
                  {filmstripCollapsed && waitingElsewhere > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-ember-400 ring-2 ring-ink-900" />
                  )}
                </span>
              </HeaderIcon>
            )}
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
              title="Hide from dashboard (keeps running in tmux)"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-ink-700 hover:text-mist-100"
            >
              <EyeOff className="h-3.5 w-3.5" /> Hide
            </button>
            <button
              onClick={() => useApp.getState().setTerminating(pane.key)}
              title="Quit the agent and close the tmux pane"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:bg-rose-400/10 hover:text-rose-400"
            >
              <Power className="h-3.5 w-3.5" /> Close
            </button>
          </div>
        </header>

        <div
          className="scroll-thin relative min-h-0 flex-1 overflow-auto rounded-xl bg-[#0e1119] p-3 ring-1 ring-ink-700"
          onMouseDown={() => setTimeout(() => termRef.current?.focus(), 0)}
        >
          <TerminalView
            ref={termRef}
            pane={pane}
            onSearch={() => setSearching(true)}
            onBack={back}
            autoFocus={!isAgent(pane.harness)}
            onCompose={() => composerRef.current?.focus()}
          />
          {searching && (
            <SearchBar
              search={termRef.current?.search ?? null}
              onClose={() => {
                setSearching(false);
                termRef.current?.focus();
              }}
            />
          )}
          {!connected && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink-950/40 backdrop-blur-[1px]">
              <span className="rounded-full bg-ink-800/90 px-3 py-1 text-[12px] text-mist-300 ring-1 ring-ink-600">Reconnecting…</span>
            </div>
          )}
        </div>
        <div className="mt-2.5 flex shrink-0 items-center gap-3">
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
        <div className="shrink-0" style={{ height: composerHeight }}>
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
        <aside
          style={{ width: filmstripWidth }}
          className="scroll-thin shrink-0 space-y-3 overflow-y-auto border-l border-ink-700/80 p-3"
        >
          {others.map((p) => (
            <MiniTile
              key={p.key}
              pane={p}
              compact
              stale={hosts[p.host]?.phase.phase === "connected" ? null : "Offline"}
              home={hosts[p.host]?.facts?.home}
            />
          ))}
        </aside>
      )}
    </div>
  );
}
