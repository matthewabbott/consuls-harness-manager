// Recent agent sessions on the phone: what's been going on lately on every connected machine
// (folder, title, the last thing asked), and a tap to go back into one: its pane when it's
// running, else it's reopened in a new one.

import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { useState } from "react";

import type { SessionSummary } from "../ipc/bindings/SessionSummary";
import { HARNESS_DOT, HARNESS_NAME } from "../lib/agents";
import { hostLabel, shortPath } from "../lib/hosts";
import { ago, matchesQuery, sessionGist, sessionPane, sessionTitle } from "../lib/recent";
import { useApp } from "../store/app";
import { openingKey, openSession, refreshRecent, useRecent, useRecentMachines, useRecentSessions } from "../store/recent";
import Chip from "./Chip";

function Row({ s, live, opening, showMachine, onOpen }: { s: SessionSummary; live: boolean; opening: boolean; showMachine: boolean; onOpen(): void }) {
  const home = useApp((st) => st.hosts[s.host]?.facts?.home ?? null);
  const gist = sessionGist(s);
  return (
    <li>
      <button
        onClick={onOpen}
        disabled={opening}
        className="flex w-full items-start gap-3 rounded-2xl bg-ink-800/80 px-3.5 py-3 text-left ring-1 ring-ink-700 active:bg-ink-700 disabled:opacity-60"
      >
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${HARNESS_DOT[s.harness]}`} title={HARNESS_NAME[s.harness]} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[15px] leading-snug font-medium text-mist-100">{sessionTitle(s)}</div>
          <div className="truncate text-[12.5px] text-mist-500">
            {shortPath(s.cwd, home)}
            {showMachine && ` · ${hostLabel(s.host)}`}
          </div>
          {gist && <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-mist-400">{gist}</div>}
        </div>
        <div className="shrink-0 pt-0.5">
          {opening ? (
            <Loader2 className="h-4 w-4 animate-spin text-mist-400" />
          ) : live ? (
            <span className="rounded-md bg-jade-400/15 px-1.5 py-0.5 text-[12px] font-semibold text-jade-300 ring-1 ring-jade-400/30">open</span>
          ) : (
            <span className="text-[12.5px] text-mist-500">{ago(s.lastActive)}</span>
          )}
        </div>
      </button>
    </li>
  );
}

export default function RecentScreen({ onClose }: { onClose(): void }) {
  const { connected, offline } = useRecentMachines();
  const byHost = useRecent((s) => s.byHost);
  const opening = useRecent((s) => s.opening);
  const panes = useApp((s) => s.panes);
  const [query, setQuery] = useState("");
  const [machine, setMachine] = useState("");

  const shown = machine && connected.includes(machine) ? [machine] : connected;
  const all = useRecentSessions(shown);
  const allPanes = Object.values(panes).flat();
  const sessions = all.filter((s) => matchesQuery(s, query, hostLabel(s.host)));
  const loading = shown.some((h) => byHost[h]?.loading);
  const failed = shown.filter((h) => byHost[h]?.error);

  const open = (s: SessionSummary) => {
    void openSession(s).then((opened) => opened && onClose());
  };

  return (
    <div className="overlay z-40 flex flex-col bg-ink-900">
      <header className="safe-top flex shrink-0 items-center gap-1 px-1.5 pb-1">
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <X className="h-6 w-6" />
        </button>
        <h1 className="ml-1 flex-1 text-[18px] font-semibold text-mist-100">Recent</h1>
        <button onClick={() => refreshRecent(shown)} disabled={connected.length === 0} aria-label="Refresh" className="rounded-full p-2 text-mist-300 active:bg-ink-700 disabled:text-mist-600">
          <RefreshCw className={`h-5 w-5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="shrink-0 space-y-2 px-3 pb-2">
        <label className="flex items-center gap-2 rounded-xl bg-ink-800 px-3 py-2 ring-1 ring-ink-700 focus-within:ring-ember-400/60">
          <Search className="h-4 w-4 shrink-0 text-mist-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, folders, prompts"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[16px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear" className="text-mist-500 active:text-mist-200">
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        {connected.length > 1 && (
          <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5">
            <Chip on={!machine} onClick={() => setMachine("")}>
              All
            </Chip>
            {connected.map((h) => (
              <Chip key={h} on={machine === h} onClick={() => setMachine(h)}>
                {hostLabel(h)}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <main className="safe-bottom min-h-0 flex-1 overflow-y-auto px-3">
        <ul className="space-y-2">
          {sessions.map((s) => (
            <Row
              key={openingKey(s)}
              s={s}
              live={sessionPane(s, allPanes) !== null}
              opening={!!opening[openingKey(s)]}
              showMachine={shown.length > 1}
              onOpen={() => open(s)}
            />
          ))}
        </ul>
        {sessions.length === 0 && (
          <p className="mt-3 px-1 text-[14px] text-mist-400">
            {connected.length === 0
              ? "No machine is connected."
              : loading && all.length === 0
                ? "Looking for sessions…"
                : query
                  ? "No session matches."
                  : "No Claude Code, Codex, pi or omp sessions in the last 30 days."}
          </p>
        )}
        {failed.map((h) => (
          <p key={h} className="mt-3 px-1 text-[13px] break-words text-rose-400">
            {hostLabel(h)}: {byHost[h]!.error}
          </p>
        ))}
        {offline.length > 0 && !machine && <p className="mt-3 mb-4 px-1 text-[13px] text-mist-500">Not connected: {offline.map(hostLabel).join(", ")}</p>}
      </main>
    </div>
  );
}
