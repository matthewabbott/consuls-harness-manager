import { Bot, Eye, EyeOff, LayoutGrid, Plus, Search, X } from "lucide-react";
import { useState } from "react";

import { backend } from "../ipc/backend";
import { displayTitle } from "./MiniTile";

import { useApp, type PaneFilter } from "../store/app";

export default function TopBar() {
  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const focusHost = useApp((s) => s.focusHost);
  const setFocusHost = useApp((s) => s.setFocusHost);
  const panes = useApp((s) => s.panes);
  const anyConnected = useApp((s) => Object.values(s.hosts).some((h) => h.phase.phase === "connected"));
  const hidden = Object.values(panes)
    .flat()
    .filter((p) => p.hidden && (!focusHost || p.host === focusHost));
  const [showHidden, setShowHidden] = useState(false);

  const tabs: { id: PaneFilter; label: string; icon: React.ReactNode }[] = [
    { id: "all", label: "All panes", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
    { id: "agents", label: "Agents", icon: <Bot className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="flex h-14 shrink-0 items-center gap-4 px-6">
      <div className="flex items-center gap-2 text-[14px]">
        <button onClick={() => setFocusHost(null)} className={focusHost ? "text-mist-400 hover:text-mist-200" : "font-semibold text-mist-100"}>
          All machines
        </button>
        {focusHost && (
          <>
            <span className="text-mist-500">/</span>
            <span className="font-semibold text-mist-100">{focusHost}</span>
          </>
        )}
      </div>

      <div className="flex rounded-lg bg-ink-800 p-0.5 ring-1 ring-ink-700">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setFilter(t.id)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
              filter === t.id ? "bg-ink-600 text-mist-100 shadow-sm" : "text-mist-400 hover:text-mist-200"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="relative ml-auto">
        {hidden.length > 0 && (
          <button
            onClick={() => setShowHidden(!showHidden)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-mist-400 hover:bg-ink-800 hover:text-mist-200"
          >
            <EyeOff className="h-3.5 w-3.5" /> {hidden.length} hidden
          </button>
        )}
        {showHidden && hidden.length > 0 && (
          <div className="animate-rise absolute top-full right-0 z-30 mt-1 w-80 rounded-xl bg-ink-800 p-1.5 shadow-2xl ring-1 ring-ink-600">
            {hidden.map((p) => (
              <div key={p.key} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-ink-750">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-mist-100">{displayTitle(p)}</div>
                  <div className="truncate font-mono text-[10.5px] text-mist-500">
                    {p.host} · {p.sessionName}:{p.windowIndex}
                  </div>
                </div>
                <button
                  onClick={() => backend().then((b) => b.setPaneHidden(p.key, false))}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-sky-400 hover:bg-ink-700"
                >
                  <Eye className="h-3.5 w-3.5" /> Show
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={() => useApp.getState().openNewPane(focusHost)}
        disabled={!anyConnected}
        className="flex items-center gap-1.5 rounded-lg bg-sky-400/90 px-3 py-1.5 text-[12.5px] font-semibold text-ink-950 transition-colors hover:bg-sky-400 disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" /> New pane
      </button>

      <div className="relative w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-mist-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter panes by title, path, session…"
          className="w-full rounded-lg bg-ink-800 py-1.5 pr-7 pl-8 text-[12.5px] text-mist-100 ring-1 ring-ink-700 outline-none placeholder:text-mist-500 focus:ring-sky-400/50"
        />
        {query && (
          <button onClick={() => setQuery("")} className="absolute top-1/2 right-2 -translate-y-1/2 text-mist-500 hover:text-mist-200">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
