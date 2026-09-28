import { create } from "zustand";

import type { AppConfig } from "../ipc/bindings/AppConfig";
import type { CoreEvent } from "../ipc/bindings/CoreEvent";
import type { CoreSnapshot } from "../ipc/bindings/CoreSnapshot";
import type { HostState } from "../ipc/bindings/HostState";
import type { NoticeLevel } from "../ipc/bindings/NoticeLevel";
import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import type { TailnetStatus } from "../ipc/bindings/TailnetStatus";

export interface Notice {
  id: number;
  host: string | null;
  level: NoticeLevel;
  message: string;
}

export type PaneFilter = "all" | "agents";

interface AppStore {
  ready: boolean;
  tailnet: TailnetStatus | null;
  config: AppConfig;
  hosts: Record<string, HostState>;
  panes: Record<string, PaneInfo[]>;
  attention: Record<number, PaneAttention>;
  notices: Notice[];
  filter: PaneFilter;
  query: string;
  focusHost: string | null;
  /** Pane key shown in the expanded view, if any. */
  expanded: number | null;
  /** Host preselected in the new-pane dialog; `undefined` = dialog closed. */
  newPaneFor: string | null | undefined;
  /** Pane pending termination confirmation. */
  terminating: number | null;
  /** Host whose integration dialog is open. */
  integrationFor: string | null;
  /** Panes whose pings/toasts are silenced (they still glow). */
  muted: Record<number, boolean>;
  /** Host whose connection-settings dialog is open. */
  settingsFor: string | null;

  init(snapshot: CoreSnapshot): void;
  apply(ev: CoreEvent): void;
  notify(level: NoticeLevel, message: string, host?: string | null): void;
  dismiss(id: number): void;
  setFilter(filter: PaneFilter): void;
  setQuery(query: string): void;
  setFocusHost(host: string | null): void;
  setExpanded(key: number | null): void;
  openNewPane(host: string | null): void;
  closeNewPane(): void;
  setTerminating(key: number | null): void;
  setIntegrationFor(host: string | null): void;
  setMuted(key: number, muted: boolean): void;
  setSettingsFor(host: string | null): void;
}

let noticeId = 1;

export const useApp = create<AppStore>((set) => ({
  ready: false,
  tailnet: null,
  config: { hosts: [] },
  hosts: {},
  panes: {},
  attention: {},
  notices: [],
  filter: "all",
  query: "",
  focusHost: null,
  expanded: null,
  newPaneFor: undefined,
  terminating: null,
  integrationFor: null,
  muted: {},
  settingsFor: null,

  init: (s) =>
    set(() => {
      const panes: Record<string, PaneInfo[]> = {};
      for (const p of s.panes) (panes[p.host] ??= []).push(p);
      return {
        ready: true,
        tailnet: s.tailnet,
        config: s.config,
        hosts: Object.fromEntries(s.hosts.map((h) => [h.id, h])),
        panes,
        attention: Object.fromEntries(s.attention.map((a) => [a.key, a])),
      };
    }),

  apply: (ev) =>
    set((st) => {
      switch (ev.type) {
        case "tailnet":
          return { tailnet: ev.status };
        case "config":
          return { config: ev.config };
        case "host":
          return { hosts: { ...st.hosts, [ev.state.id]: ev.state } };
        case "hostRemoved": {
          const hosts = { ...st.hosts };
          const panes = { ...st.panes };
          delete hosts[ev.id];
          delete panes[ev.id];
          return { hosts, panes };
        }
        case "panes":
          return { panes: { ...st.panes, [ev.host]: ev.panes } };
        case "attention":
          return { attention: { ...st.attention, [ev.state.key]: ev.state } };
        case "notice":
          return { notices: [...st.notices, { id: noticeId++, host: ev.host, level: ev.level, message: ev.message }].slice(-6) };
      }
    }),

  notify: (level, message, host = null) =>
    set((st) => ({ notices: [...st.notices, { id: noticeId++, host, level, message }].slice(-6) })),
  dismiss: (id) => set((st) => ({ notices: st.notices.filter((n) => n.id !== id) })),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setFocusHost: (focusHost) => set({ focusHost }),
  setExpanded: (expanded) => set({ expanded }),
  openNewPane: (host) => set({ newPaneFor: host }),
  closeNewPane: () => set({ newPaneFor: undefined }),
  setTerminating: (terminating) => set({ terminating }),
  setIntegrationFor: (integrationFor) => set({ integrationFor }),
  setMuted: (key, muted) => set((st) => ({ muted: { ...st.muted, [key]: muted } })),
  setSettingsFor: (settingsFor) => set({ settingsFor }),
}));
