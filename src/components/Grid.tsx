import { Plus } from "lucide-react";
import { useMemo } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { machines, phaseInfo, toneText } from "../lib/hosts";
import { useApp } from "../store/app";
import { isAgent } from "./HarnessBadge";
import MiniTile from "./MiniTile";

function matches(p: PaneInfo, q: string): boolean {
  if (!q) return true;
  const hay = `${p.title} ${p.windowName} ${p.sessionName} ${p.currentPath} ${p.currentCommand} ${p.host}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export default function Grid() {
  const tailnet = useApp((s) => s.tailnet);
  const config = useApp((s) => s.config);
  const hosts = useApp((s) => s.hosts);
  const panes = useApp((s) => s.panes);
  const filter = useApp((s) => s.filter);
  const query = useApp((s) => s.query);
  const focusHost = useApp((s) => s.focusHost);

  const sections = useMemo(() => {
    const { configured } = machines(tailnet, config.hosts, hosts);
    return configured
      .filter((m) => !focusHost || m.id === focusHost)
      .map((m) => {
        const list = (panes[m.id] ?? []).filter((p) => !p.hidden && (filter === "all" || isAgent(p.harness)) && matches(p, query));
        return { m, list };
      });
  }, [tailnet, config.hosts, hosts, panes, filter, query, focusHost]);

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-6 pt-2 pb-10">
      {sections.map(({ m, list }) => {
        const info = phaseInfo(m.state?.phase, m.peer?.online);
        const connected = m.state?.phase.phase === "connected";
        const stale = connected ? null : info.label;
        const total = panes[m.id]?.length ?? 0;
        return (
          <section key={m.id} className="mb-8">
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-mist-100">{m.label}</h2>
              <span className={`text-[12px] ${toneText[info.tone]}`}>{info.label}</span>
              {m.state?.facts && (
                <span className="font-mono text-[11px] text-mist-500">
                  {m.state.facts.user}@{m.label} · tmux {m.state.facts.tmuxVersion ?? "missing"}
                </span>
              )}
              <span className="ml-auto text-[12px] text-mist-500">
                {list.length === total ? `${total} pane${total === 1 ? "" : "s"}` : `${list.length} of ${total} panes`}
              </span>
              {connected && (
                <button
                  onClick={() => useApp.getState().openNewPane(m.id)}
                  title={`New pane on ${m.label}`}
                  className="self-center rounded-md p-1 text-mist-500 transition-colors hover:bg-ink-700 hover:text-mist-100"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            </div>
            {list.length > 0 ? (
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
                {list.map((p) => (
                  <MiniTile key={p.key} pane={p} stale={stale} home={m.state?.facts?.home} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-ink-600 px-5 py-8 text-center text-[13px] text-mist-500">
                {connected
                  ? m.state?.facts && !m.state.facts.tmuxVersion
                    ? `tmux isn't installed on ${m.label} (or isn't on your login shell's PATH). Install tmux 3.2+ — e.g. \`brew install tmux\` or \`apt install tmux\` — then reconnect.`
                    : total === 0
                      ? "No tmux sessions on this machine yet. Use + to start one."
                      : "No panes match the current filter."
                  : m.state?.phase.phase === "connecting"
                    ? "Connecting…"
                    : "Not connected."}
              </div>
            )}
          </section>
        );
      })}
      {sections.length === 0 && <EmptyState />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <img src="/app-icon.svg" alt="" className="mx-auto mb-5 h-16 w-16 opacity-90" />
      <h2 className="font-display text-xl font-semibold text-mist-100">Bring in a machine</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-mist-400">
        Pick a machine under <span className="text-mist-200">On your tailnet</span> in the sidebar. Consuls attaches to its tmux
        sessions without resizing or disturbing them, and shows every pane here.
      </p>
    </div>
  );
}
