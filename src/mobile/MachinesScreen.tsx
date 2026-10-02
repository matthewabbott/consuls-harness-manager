import { ChevronRight, FolderOpen, Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";

import NotifySwitch from "../components/NotifySwitch";
import { backend } from "../ipc/backend";
import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { HARNESS_DOT, HARNESS_NAME, phaseText, status, trackable } from "../lib/agents";
import { pausedText } from "../lib/notifyModes";
import { displayTitle, paneWhere } from "../lib/panes";
import { useApp } from "../store/app";
import { useFilesScreen } from "./files";

/** Waiting for you first, then needing input, working, the rest; by name within each. */
function rank(att: PaneAttention | undefined): number {
  if (!att) return 4;
  if (att.activity === "needsInput") return 0;
  if (att.activity === "idle" && att.attention !== "none") return 1;
  if (att.activity === "working") return 2;
  return 3;
}

function AgentRow({ pane, att }: { pane: PaneInfo; att: PaneAttention | undefined }) {
  const st = status(att);
  const harness = pane.harness ?? "shell";
  return (
    <li>
      <div
        role="button"
        onClick={() => useApp.getState().setExpanded(pane.key)}
        className={`flex items-center gap-3 rounded-2xl bg-ink-800/80 px-3.5 py-3 ring-1 ring-ink-700 active:bg-ink-700 ${pane.hidden ? "opacity-50" : ""}`}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${HARNESS_DOT[harness]}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium text-mist-100">{displayTitle(pane)}</div>
          <div className="truncate text-[12.5px]">
            <span className={st.tone}>{st.text || HARNESS_NAME[harness]}</span>
            <span className="text-mist-500"> · {paneWhere(pane)}</span>
          </div>
        </div>
        {trackable(pane) ? (
          <NotifySwitch on={pane.notify !== null} onToggle={() => backend().then((b) => b.setPaneNotify(pane.key, pane.notify ? null : "delay"))} />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-mist-500" />
        )}
      </div>
    </li>
  );
}

export default function MachinesScreen({ onSettings, onAdd, onNew }: { onSettings(): void; onAdd(): void; onNew(host: string): void }) {
  const config = useApp((s) => s.config);
  const hosts = useApp((s) => s.hosts);
  const panes = useApp((s) => s.panes);
  const attention = useApp((s) => s.attention);
  // The web app's server watches its own machine as `@local`.
  const selfName = useApp((s) => s.tailnet?.selfNode?.id ?? "this machine");
  // Shells too by default: on the phone they're as much a reason to open the app as agents.
  const [shells, setShells] = useState(true);
  const paused = useApp((s) => pausedText(s.config.notify.pausedUntil));
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = useMemo(() => Object.values(panes).flat().filter((p) => p.hidden).length, [panes]);

  const machines = useMemo(() => {
    const ids = [...new Set([...(hosts["@local"] ? ["@local"] : []), ...config.hosts.map((h) => h.id), ...Object.keys(hosts)])];
    return ids.map((id) => ({
      id,
      name: id === "@local" ? selfName : id,
      phase: hosts[id]?.phase,
      panes: (panes[id] ?? [])
        .filter((p) => (showHidden || !p.hidden) && (shells || trackable(p)))
        .sort((a, b) => rank(attention[a.key]) - rank(attention[b.key]) || displayTitle(a).localeCompare(displayTitle(b))),
    }));
  }, [config.hosts, hosts, panes, attention, shells, showHidden, selfName]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="safe-top flex shrink-0 items-center px-4 pb-2">
        <h1 className="flex-1 text-[28px] font-bold tracking-tight text-mist-100">Consuls</h1>
        <button onClick={onSettings} aria-label="Settings" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
          <Settings className="h-5.5 w-5.5" />
        </button>
      </header>

      <main className="safe-bottom min-h-0 flex-1 overflow-y-auto px-4">
        {paused && (
          <button onClick={onSettings} className="mt-1 w-full rounded-xl bg-ember-400/10 px-3.5 py-2.5 text-left text-[13.5px] text-ember-300 ring-1 ring-ember-400/30">
            {paused} · Settings
          </button>
        )}
        {machines.length === 0 && (
          <section className="mt-6 rounded-2xl bg-ink-800 px-4 py-5 ring-1 ring-ink-700">
            <h2 className="text-[17px] font-semibold text-mist-100">Add your first machine</h2>
            <p className="mt-1.5 text-[14px] leading-snug text-mist-400">
              Consuls connects to your machines over Tailscale SSH, and shows the agents running in their tmux. After the first one, the
              rest of your tailnet is listed to pick from.
            </p>
            <button onClick={onAdd} className="mt-4 w-full rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80">
              Add a machine
            </button>
          </section>
        )}

        {machines.map((m) => {
          const phase = phaseText(m.phase);
          const down = !m.phase || m.phase.phase === "disconnected" || m.phase.phase === "failed";
          const check = m.phase?.phase === "awaitingTailscaleCheck" ? m.phase.url : null;
          return (
            <section key={m.id} className="mt-4">
              <div className="mb-2 flex items-center gap-2 px-1">
                <h2 className="shrink-0 text-[15px] font-semibold text-mist-100">{m.name}</h2>
                {phase && <span className={`min-w-0 truncate text-[12px] ${phase.tone}`}>{phase.text}</span>}
                {check && (
                  <button
                    onClick={() => backend().then((b) => b.openExternal(check))}
                    className="ml-auto shrink-0 rounded-lg bg-iris-400/15 px-2.5 py-1 text-[13px] font-medium text-iris-300 active:bg-iris-400/25"
                  >
                    Approve
                  </button>
                )}
                {down && (
                  <button
                    onClick={() => backend().then((b) => b.connectHost(m.id))}
                    className="ml-auto shrink-0 rounded-lg bg-ink-700 px-2.5 py-1 text-[13px] font-medium text-mist-100 active:bg-ink-600"
                  >
                    Connect
                  </button>
                )}
                {m.phase?.phase === "connected" && (
                  <>
                    <button
                      onClick={() => useFilesScreen.getState().open({ host: m.id, dir: config.ui.defaultFolders[m.id] ?? "~" })}
                      aria-label={`Files on ${m.name}`}
                      className="-my-1 ml-auto shrink-0 rounded-full p-1.5 text-mist-300 active:bg-ink-700"
                    >
                      <FolderOpen className="h-5 w-5" />
                    </button>
                    <button onClick={() => onNew(m.id)} aria-label={`New session on ${m.name}`} className="-my-1 shrink-0 rounded-full p-1.5 text-ember-400 active:bg-ink-700">
                      <Plus className="h-5 w-5" />
                    </button>
                  </>
                )}
              </div>
              {m.panes.length === 0 ? (
                <p className="px-1 text-[13px] text-mist-500">{m.phase?.phase === "connected" ? (shells ? "Nothing running." : "No agents running.") : ""}</p>
              ) : (
                <ul className="space-y-2">
                  {m.panes.map((p) => (
                    <AgentRow key={p.key} pane={p} att={attention[p.key]} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        {machines.length > 0 && (
          <div className="mt-6 mb-4 flex items-center justify-between px-1">
            <div className="flex gap-4">
              <button onClick={() => setShells(!shells)} className="text-[13px] text-mist-400 active:text-mist-200">
                {shells ? "Agents only" : "Show shells too"}
              </button>
              {hiddenCount > 0 && (
                <button onClick={() => setShowHidden(!showHidden)} className="text-[13px] text-mist-400 active:text-mist-200">
                  {showHidden ? "Hide hidden" : `Hidden (${hiddenCount})`}
                </button>
              )}
            </div>
            <button onClick={onAdd} className="flex items-center gap-1 text-[13px] text-mist-400 active:text-mist-200">
              <Plus className="h-3.5 w-3.5" /> Add a machine
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
