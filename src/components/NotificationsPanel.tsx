// The Notifications tab of the left sidebar: what pinged (agents finished or needing you, bells,
// subtasks, summaries), newest first, from the core's list. A click shows the pane, which
// resolves its "waiting on you". Opening the tab marks everything read.

import { BellRing, CheckCircle2, CircleHelp, Layers, ListChecks } from "lucide-react";
import { useEffect, useState } from "react";

import { backend } from "../ipc/backend";
import type { AlertEntry } from "../ipc/bindings/AlertEntry";
import type { AlertKind } from "../ipc/bindings/AlertKind";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { hostLabel } from "../lib/hosts";
import { displayTitle } from "../lib/panes";
import { ago } from "../lib/recent";
import { useAlertsSeen } from "../store/alerts";
import { useApp } from "../store/app";
import { useLayout } from "../store/layout";
import { useRedact } from "../store/recording";
import HarnessBadge from "./HarnessBadge";
import HideSidebarButton from "./HideSidebarButton";

const KINDS: Record<AlertKind, { label: string; icon: React.ReactNode }> = {
  finished: { label: "finished", icon: <CheckCircle2 className="h-3.5 w-3.5 text-ember-400" /> },
  needsInput: { label: "needs you", icon: <CircleHelp className="h-3.5 w-3.5 text-iris-300" /> },
  bell: { label: "rang the bell", icon: <BellRing className="h-3.5 w-3.5 text-sky-400" /> },
  subtask: { label: "subtask done", icon: <ListChecks className="h-3.5 w-3.5 text-mist-500" /> },
  summary: { label: "while you were away", icon: <Layers className="h-3.5 w-3.5 text-mist-400" /> },
};

function Row({ entry, pane, unread }: { entry: AlertEntry; pane: PaneInfo | undefined; unread: boolean }) {
  const r = useRedact();
  const kind = KINDS[entry.kind];
  const gone = entry.key !== null && !pane;
  const open = () => {
    if (pane) {
      void backend().then((b) => b.ackPane(pane.key));
      useApp.getState().setExpanded(pane.key);
    } else if (entry.key === null && entry.host) {
      useApp.getState().setFocusHost(entry.host);
      useLayout.getState().toGrid();
    }
  };
  return (
    <button
      onClick={open}
      disabled={gone}
      title={gone ? "That pane is gone (closed, or a restart gave it a new key)" : [r(entry.title), r(entry.body)].filter(Boolean).join("\n")}
      className={`relative flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink-750 disabled:opacity-45 disabled:hover:bg-transparent ${
        unread ? "bg-ink-800/60" : ""
      }`}
    >
      {unread && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-ember-400" />}
      <span className="mt-px shrink-0">{pane ? <HarnessBadge harness={pane.harness} size={17} /> : kind.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-mist-100">{r(pane ? displayTitle(pane) : entry.title)}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-mist-500">{ago(entry.at)}</span>
        </span>
        <span className="flex items-center gap-1 text-[11px] text-mist-400">
          {pane && kind.icon}
          <span className="truncate">
            {kind.label}
            {entry.host && <> · {r(hostLabel(entry.host))}</>}
            {gone && " · gone"}
          </span>
        </span>
        {entry.body && entry.kind !== "summary" && <span className="block truncate text-[11px] text-mist-500">{r(entry.body)}</span>}
      </span>
    </button>
  );
}

export default function NotificationsPanel() {
  const alerts = useApp((s) => s.alerts);
  const panes = useApp((s) => s.panes);
  const clearedAt = useAlertsSeen((s) => s.clearedAt);
  // What was unread when the tab opened stays marked while it's open.
  const [since] = useState(() => useAlertsSeen.getState().seenAt);
  const [, tick] = useState(0);
  const list = alerts.filter((a) => a.at > clearedAt).reverse();
  const byKey = new Map(Object.values(panes).flat().map((p) => [p.key, p]));

  useEffect(() => {
    const last = alerts.at(-1);
    if (last) useAlertsSeen.getState().markSeen(last.at);
  }, [alerts]);
  // "5m ago" moves on.
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-1">
        <div className="flex-1 text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">Notifications</div>
        <button
          onClick={() => useAlertsSeen.getState().clear(alerts.at(-1)?.at ?? Date.now() / 1000)}
          disabled={list.length === 0}
          className="rounded px-1.5 py-0.5 text-[11px] text-mist-400 hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40"
        >
          Clear
        </button>
        <HideSidebarButton />
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
        {list.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-mist-500">
            Nothing yet. Agents finishing or asking for you, bells and subtasks show up here as they ping; click one to go to its pane.
          </p>
        ) : (
          list.map((a) => <Row key={`${a.at}-${a.id}`} entry={a} pane={a.key === null ? undefined : byKey.get(a.key)} unread={a.at > since} />)
        )}
      </div>
    </div>
  );
}
