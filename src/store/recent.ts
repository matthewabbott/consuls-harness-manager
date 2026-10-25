// Recent agent sessions per machine (the desktop's History tab, the phone's Recent screen), as
// the machines' own session files tell them, and opening one: its pane when it's running, else
// reopened in a new one.

import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { openWhenListed } from "../components/PrefixKeys";
import { backend } from "../ipc/backend";
import type { SessionSummary } from "../ipc/bindings/SessionSummary";
import { hostLabel, LOCAL_HOST } from "../lib/hosts";
import { sessionPane, sessionTitle } from "../lib/recent";
import { useApp } from "./app";

export interface MachineSessions {
  loading: boolean;
  error: string | null;
  sessions: SessionSummary[];
}

interface RecentStore {
  byHost: Record<string, MachineSessions>;
  /** Sessions being reopened (`host\nid`): another click waits for the first. */
  opening: Record<string, boolean>;
  load(host: string): Promise<void>;
}

const NOTHING_YET: MachineSessions = { loading: false, error: null, sessions: [] };

export const useRecent = create<RecentStore>((set) => ({
  byHost: {},
  opening: {},
  load: async (host) => {
    const update = (patch: Partial<MachineSessions>) =>
      set((st) => ({ byHost: { ...st.byHost, [host]: { ...(st.byHost[host] ?? NOTHING_YET), ...patch } } }));
    update({ loading: true });
    try {
      update({ sessions: await (await backend()).recentSessions(host), loading: false, error: null });
    } catch (e) {
      update({ loading: false, error: String(e) });
    }
  },
}));

export const openingKey = (s: SessionSummary) => `${s.host}\n${s.id}`;

/** Shows the session's pane when it's running; otherwise reopens it in a new pane and shows that. */
export async function openSession(s: SessionSummary): Promise<boolean> {
  const live = sessionPane(s, Object.values(useApp.getState().panes).flat());
  if (live) {
    openWhenListed(live.key);
    return true;
  }
  const key = openingKey(s);
  if (useRecent.getState().opening[key]) return false;
  const opening = (on: boolean) => useRecent.setState((st) => ({ opening: { ...st.opening, [key]: on } }));
  opening(true);
  try {
    const b = await backend();
    const pane = await b.createPane({ host: s.host, cwd: s.cwd, harness: s.harness, name: null, session: null, args: null, resume: s.resume });
    openWhenListed(pane);
    return true;
  } catch (e) {
    useApp.getState().notify("error", `Couldn't reopen “${sessionTitle(s)}” on ${hostLabel(s.host)}: ${e}`, s.host);
    return false;
  } finally {
    opening(false);
  }
}

/**
 * The machines whose sessions can be listed (connected ones, This PC first) and the rest; each
 * connected machine's list is loaded when this mounts (the tab or screen opened) and when it
 * connects.
 */
export function useRecentMachines(): { connected: string[]; offline: string[] } {
  const hosts = useApp((s) => s.hosts);
  const configured = useApp((s) => s.config.hosts);
  const connectedKey = Object.values(hosts)
    .filter((h) => h.phase.phase === "connected")
    .map((h) => h.id)
    .sort((a, b) => Number(b === LOCAL_HOST) - Number(a === LOCAL_HOST) || a.localeCompare(b))
    .join("\n");
  const connected = useMemo(() => (connectedKey ? connectedKey.split("\n") : []), [connectedKey]);
  const offline = configured.map((c) => c.id).filter((id) => !connected.includes(id));
  const loaded = useRef<string[]>([]);
  useEffect(() => {
    refreshRecent(connected.filter((h) => !loaded.current.includes(h)));
    loaded.current = connected;
  }, [connected]);
  return { connected, offline };
}

/** Loads every connected machine's sessions again. */
export function refreshRecent(hosts: string[]) {
  for (const h of hosts) void useRecent.getState().load(h);
}

/** Every listed session of these machines, newest first. */
export function useRecentSessions(hosts: string[]): SessionSummary[] {
  const byHost = useRecent((s) => s.byHost);
  return useMemo(() => hosts.flatMap((h) => byHost[h]?.sessions ?? []).sort((a, b) => b.lastActive - a.lastActive), [hosts, byHost]);
}
