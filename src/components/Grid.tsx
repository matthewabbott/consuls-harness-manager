import { Plus, Tag } from "lucide-react";
import { useMemo } from "react";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { hostLabel, isLocal, machines, phaseInfo, toneText } from "../lib/hosts";
import { groupPanes, sortPanes } from "../lib/organize";
import { paneIdentity, paneName, paneWhere } from "../lib/panes";
import { useApp } from "../store/app";
import { useRedact } from "../store/recording";
import { useUi } from "../store/ui";
import { isAgent } from "./HarnessBadge";
import FileTile from "./FileTile";
import MiniTile, { displayTitle } from "./MiniTile";
import { useEditor } from "../store/editor";

function matches(p: PaneInfo, q: string, labelNames: string): boolean {
  if (!q) return true;
  const hay = `${p.title} ${paneName(p)} ${paneWhere(p)} ${p.currentPath} ${p.currentCommand} ${hostLabel(p.host)} ${labelNames}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

const GRID_STYLE = { gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" };

export default function Grid() {
  const tailnet = useApp((s) => s.tailnet);
  const config = useApp((s) => s.config);
  const hosts = useApp((s) => s.hosts);
  const panes = useApp((s) => s.panes);
  const attention = useApp((s) => s.attention);
  const filter = useApp((s) => s.filter);
  const query = useApp((s) => s.query);
  const focusHost = useApp((s) => s.focusHost);
  const focusLabel = useApp((s) => s.focusLabel);
  const groupBy = useUi((s) => s.groupBy);
  const sortBy = useUi((s) => s.sortBy);
  const lastOpened = useUi((s) => s.lastOpened);
  const r = useRedact();
  const openFiles = useEditor((s) => s.files);
  const fileOrder = useEditor((s) => s.order);
  /** Open files by the pane they came from (null: none, or that pane is gone). */
  const filesByOrigin = useMemo(() => {
    const alive = new Set(Object.values(panes).flat().map((p) => p.key));
    const by = new Map<string, string[]>();
    for (const id of fileOrder) {
      const f = openFiles[id];
      if (!f) continue;
      const slot = f.origin !== null && alive.has(f.origin) ? `pane:${f.origin}` : `host:${f.host}`;
      by.set(slot, [...(by.get(slot) ?? []), id]);
    }
    return by;
  }, [openFiles, fileOrder, panes]);

  const { configured } = useMemo(() => machines(tailnet, config.hosts, hosts), [tailnet, config.hosts, hosts]);

  const keep = useMemo(() => {
    const names = (p: PaneInfo) => p.labels.map((id) => config.labels.find((l) => l.id === id)?.name ?? id).join(" ");
    return (p: PaneInfo) =>
      !p.hidden &&
      (filter === "all" || isAgent(p.harness)) &&
      (!focusHost || p.host === focusHost) &&
      (!focusLabel || p.labels.includes(focusLabel)) &&
      matches(p, query, names(p));
  }, [config.labels, filter, focusHost, focusLabel, query]);

  const sort = (list: PaneInfo[]) => sortPanes(list, sortBy, displayTitle, attention, lastOpened, paneIdentity);
  const staleFor = (host: string) => {
    const state = hosts[host];
    return state?.phase.phase === "connected" ? null : phaseInfo(state?.phase, undefined).label;
  };

  const focusBanner = focusLabel && (
    <div className="mb-4 flex items-center gap-2 text-[12.5px] text-mist-400">
      <Tag className="h-3.5 w-3.5" style={{ color: config.labels.find((l) => l.id === focusLabel)?.color }} />
      Showing panes labelled <span className="font-medium text-mist-100">{config.labels.find((l) => l.id === focusLabel)?.name ?? focusLabel}</span>
      <button onClick={() => useApp.getState().setFocusLabel(null)} className="ml-1 text-sky-400 hover:underline">
        show all
      </button>
    </div>
  );

  if (groupBy !== "machine") {
    const visible = configured.flatMap((m) => panes[m.id] ?? []).filter(keep);
    const groups = groupPanes(visible, groupBy, config.labels, attention);
    return (
      <div className="scroll-thin flex-1 overflow-y-auto px-6 pt-2 pb-10">
        {focusBanner}
        {groups.map((g) => (
          <section key={g.id} className="mb-8">
            <div className="mb-3 flex items-baseline gap-2.5">
              {g.color && <span className="h-2.5 w-2.5 self-center rounded-full" style={{ background: g.color }} />}
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-mist-100">{r(g.title)}</h2>
              <span className="ml-auto text-[12px] text-mist-500">
                {g.panes.length} pane{g.panes.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid gap-4" style={GRID_STYLE}>
              {sort(g.panes).map((p) => (
                <MiniTile key={`${g.id}:${p.key}`} pane={p} stale={staleFor(p.host)} home={hosts[p.host]?.facts?.home} showHost />
              ))}
            </div>
          </section>
        ))}
        {fileOrder.length > 0 && (
          <section className="mb-8">
            <div className="mb-3 flex items-baseline gap-2.5">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-mist-100">Open files</h2>
            </div>
            <div className="grid gap-4" style={GRID_STYLE}>
              {fileOrder.map((id) => (
                <FileTile key={id} id={id} home={hosts[openFiles[id]?.host ?? ""]?.facts?.home} showHost />
              ))}
            </div>
          </section>
        )}
        {groups.length === 0 && fileOrder.length === 0 && (
          <div className="rounded-xl border border-dashed border-ink-600 px-5 py-8 text-center text-[13px] text-mist-500">No panes match.</div>
        )}
      </div>
    );
  }

  const sections = configured.filter((m) => !focusHost || m.id === focusHost).map((m) => ({ m, list: sort((panes[m.id] ?? []).filter(keep)) }));
  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-6 pt-2 pb-10">
      {focusBanner}
      {sections.map(({ m, list }) => {
        const local = isLocal(m.id);
        const info = local ? { label: "", tone: "jade" as const, busy: false } : phaseInfo(m.state?.phase, m.peer?.online);
        const connected = m.state?.phase.phase === "connected";
        const stale = connected ? null : info.label;
        const total = panes[m.id]?.length ?? 0;
        return (
          <section key={m.id} className="mb-8">
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="font-display text-[17px] font-semibold tracking-tight text-mist-100">{r(m.label)}</h2>
              <span className={`text-[12px] ${toneText[info.tone]}`}>{info.label}</span>
              {m.state?.facts && (
                <span className="font-mono text-[11px] text-mist-500">
                  {r(
                    local
                      ? `${m.state.facts.user} · ${m.state.facts.uname}${m.state.facts.tmuxVersion ? ` · tmux ${m.state.facts.tmuxVersion}` : ""}`
                      : `${m.state.facts.user}@${m.label} · tmux ${m.state.facts.tmuxVersion ?? "missing"}`,
                  )}
                </span>
              )}
              <span className="ml-auto text-[12px] text-mist-500">
                {list.length === total ? `${total} pane${total === 1 ? "" : "s"}` : `${list.length} of ${total} panes`}
              </span>
              {connected && (
                <button
                  onClick={() => useApp.getState().openNewPane(m.id)}
                  title={`New pane on ${r(m.label)}`}
                  className="self-center rounded-md p-1 text-mist-500 transition-colors hover:bg-ink-700 hover:text-mist-100"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            </div>
            {list.length > 0 || filesByOrigin.has(`host:${m.id}`) ? (
              <div className="grid gap-4" style={GRID_STYLE}>
                {list.flatMap((p) => [
                  <MiniTile key={p.key} pane={p} stale={stale} home={m.state?.facts?.home} />,
                  ...(filesByOrigin.get(`pane:${p.key}`) ?? []).map((id) => <FileTile key={id} id={id} home={m.state?.facts?.home} />),
                ])}
                {(filesByOrigin.get(`host:${m.id}`) ?? []).map((id) => (
                  <FileTile key={id} id={id} home={m.state?.facts?.home} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-ink-600 px-5 py-8 text-center text-[13px] text-mist-500">
                {local
                  ? total === 0
                    ? "No shells on this PC yet. Use + to start one (PowerShell, Git Bash, …) — optionally with an agent in it."
                    : "No panes match the current filter."
                  : connected
                  ? m.state?.facts && !m.state.facts.tmuxVersion
                    ? `tmux isn't installed on ${m.label}. Use + for a plain shell, or install tmux 3.2+ (e.g. \`brew install tmux\` or \`apt install tmux\`) and reconnect for panes that survive disconnects.`
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
        Pick a machine under <span className="text-mist-200">On your tailnet</span> in the sidebar. Harness Manager attaches to its tmux
        sessions without resizing or disturbing them, and shows every pane here.
      </p>
    </div>
  );
}
