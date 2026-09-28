import { ArrowLeft, Bell, BellOff, EyeOff, Power, Search } from "lucide-react";

import { backend } from "../ipc/backend";
import { useMemo, useRef, useState } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { shortPath } from "../lib/hosts";
import { useApp } from "../store/app";
import Composer, { type ComposerHandle } from "./Composer";
import HarnessBadge, { harnessLabel, isAgent } from "./HarnessBadge";
import { displayTitle } from "./MiniTile";
import MiniTile from "./MiniTile";
import QuickKeys from "./QuickKeys";
import SearchBar from "./SearchBar";
import TerminalView, { type TerminalHandle } from "./TerminalView";

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

  const others = useMemo(
    () =>
      Object.values(panes)
        .flat()
        .filter((p) => p.key !== pane.key && !p.hidden),
    [panes, pane.key],
  );

  const back = () => setExpanded(null);

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
        <div className="mt-2 shrink-0">
          <Composer
            ref={composerRef}
            pane={pane}
            onEscapeEmpty={() => backend().then((b) => b.sendKeys(pane.key, ["Escape"]))}
          />
        </div>
      </section>

      {others.length > 0 && (
        <aside className="scroll-thin w-72 shrink-0 space-y-3 overflow-y-auto border-l border-ink-700/80 p-3">
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
