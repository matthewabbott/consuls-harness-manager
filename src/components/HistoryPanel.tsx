// The History tab of the left sidebar: recent agent sessions on every connected machine, from
// the harnesses' own session files. A session that's running shows its pane; another is
// reopened in a new one.

import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { useState } from "react";

import type { SessionSummary } from "../ipc/bindings/SessionSummary";
import { hostLabel, shortPath } from "../lib/hosts";
import { ago, matchesQuery, sessionGist, sessionPane, sessionTitle } from "../lib/recent";
import { useApp } from "../store/app";
import { openingKey, openSession, refreshRecent, useRecent, useRecentMachines, useRecentSessions } from "../store/recent";
import { useRedact } from "../store/recording";
import HarnessBadge, { harnessLabel } from "./HarnessBadge";
import HideSidebarButton from "./HideSidebarButton";

function SessionRow({ s, live, opening, showMachine }: { s: SessionSummary; live: boolean; opening: boolean; showMachine: boolean }) {
  const r = useRedact();
  const home = useApp((st) => st.hosts[s.host]?.facts?.home ?? null);
  const title = sessionTitle(s);
  const gist = sessionGist(s);
  const folder = shortPath(s.cwd, home);
  const machine = hostLabel(s.host);
  const tip = [title, `${harnessLabel(s.harness)} · ${s.cwd} · ${machine}`, s.firstPrompt && `First: ${s.firstPrompt}`, s.lastPrompt && `Last: ${s.lastPrompt}`]
    .filter(Boolean)
    .map((t) => r(t as string))
    .join("\n");
  return (
    <button
      onClick={() => void openSession(s)}
      disabled={opening}
      title={tip}
      className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink-750 disabled:opacity-60"
    >
      <span className="mt-px">
        <HarnessBadge harness={s.harness} size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-mist-100">{r(title)}</span>
          {opening ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-mist-400" />
          ) : live ? (
            <span className="shrink-0 rounded bg-jade-400/15 px-1 text-[10px] font-semibold text-jade-300 ring-1 ring-jade-400/30">open</span>
          ) : (
            <span className="shrink-0 font-mono text-[10.5px] text-mist-500">{ago(s.lastActive)}</span>
          )}
        </span>
        <span className="block truncate text-[11px] text-mist-500">
          {r(folder)}
          {showMachine && ` · ${r(machine)}`}
        </span>
        {gist && <span className="block truncate text-[11px] text-mist-400">{r(gist)}</span>}
      </span>
    </button>
  );
}

export default function HistoryPanel() {
  const { connected, offline } = useRecentMachines();
  const byHost = useRecent((s) => s.byHost);
  const opening = useRecent((s) => s.opening);
  const panes = useApp((s) => s.panes);
  const [query, setQuery] = useState("");
  const [machine, setMachine] = useState<string>("");
  const r = useRedact();

  const shown = machine && connected.includes(machine) ? [machine] : connected;
  const all = useRecentSessions(shown);
  const allPanes = Object.values(panes).flat();
  const sessions = all.filter((s) => matchesQuery(s, query, hostLabel(s.host)));
  const loading = shown.some((h) => byHost[h]?.loading);
  const failed = shown.filter((h) => byHost[h]?.error);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-1">
        <div className="flex-1 text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">History</div>
        <button
          title="Refresh"
          disabled={connected.length === 0}
          onClick={() => refreshRecent(shown)}
          className="rounded p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <HideSidebarButton />
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-ink-800 px-1.5 py-1 ring-1 ring-ink-700 focus-within:ring-sky-400/50">
          <Search className="h-3.5 w-3.5 shrink-0 text-mist-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Title, folder, prompt…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          {query && (
            <button onClick={() => setQuery("")} title="Clear" className="text-mist-500 hover:text-mist-200">
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
        {connected.length > 1 && (
          <select
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            title="Machine"
            className="w-24 shrink-0 truncate rounded-md bg-ink-800 px-1 py-1 text-[12px] text-mist-200 ring-1 ring-ink-700 outline-none"
          >
            <option value="">All machines</option>
            {connected.map((h) => (
              <option key={h} value={h}>
                {r(hostLabel(h))}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-1.5 pb-3">
        {sessions.map((s) => (
          <SessionRow key={openingKey(s)} s={s} live={sessionPane(s, allPanes) !== null} opening={!!opening[openingKey(s)]} showMachine={shown.length > 1} />
        ))}
        {sessions.length === 0 && (
          <p className="px-2.5 py-2 text-[12px] leading-relaxed text-mist-500">
            {connected.length === 0
              ? "Connect a machine to see its recent agent sessions."
              : loading && all.length === 0
                ? "Looking for sessions…"
                : query
                  ? "No session matches."
                  : "No Claude Code, Codex, pi or omp sessions in the last 30 days."}
          </p>
        )}
        {failed.map((h) => (
          <p key={h} className="px-2.5 pt-2 text-[11px] leading-snug break-words text-rose-400">
            {r(hostLabel(h))}: {r(byHost[h]!.error!)}
          </p>
        ))}
        {offline.length > 0 && !machine && (
          <p className="px-2.5 pt-2 text-[11px] leading-snug text-mist-600">Not connected: {offline.map((h) => r(hostLabel(h))).join(", ")}</p>
        )}
      </div>
    </div>
  );
}
