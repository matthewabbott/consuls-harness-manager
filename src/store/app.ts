import { create } from "zustand";

import type { AppConfig } from "../ipc/bindings/AppConfig";
import type { CoreEvent } from "../ipc/bindings/CoreEvent";
import type { CoreSnapshot } from "../ipc/bindings/CoreSnapshot";
import type { HostState } from "../ipc/bindings/HostState";
import type { NoticeLevel } from "../ipc/bindings/NoticeLevel";
import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import type { TailnetStatus } from "../ipc/bindings/TailnetStatus";
import { paneIdentity, paneName } from "../lib/panes";
import { renameIdentity } from "./composer";
import { useViewPrefs } from "./viewPrefs";
import type { TileMenuState } from "../components/TileMenu";

/** A pane just got a stable @chm_id: carry its drafts, history and view prefs over. */
function migrateIdentities(before: PaneInfo[] | undefined, after: PaneInfo[]) {
  if (!before) return;
  for (const p of after) {
    const old = before.find((b) => b.key === p.key);
    if (old && !old.chmId && p.chmId) {
      const from = paneIdentity(old);
      const to = paneIdentity(p);
      useViewPrefs.getState().rename(from, to);
      renameIdentity(from, to);
    }
  }
}

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
  focusLabel: string | null;
  tileMenu: TileMenuState | null;
  /** Pane key shown in the expanded view, if any. */
  expanded: number | null;
  /** Host preselected in the new-pane dialog; `undefined` = dialog closed. */
  newPaneFor: string | null | undefined;
  /** Folder to start the new-pane dialog in (e.g. "open a shell here" from the explorer). */
  newPaneCwd: string | null;
  /** Pane pending termination confirmation. */
  terminating: number | null;
  /** Host whose integration dialog is open. */
  integrationFor: string | null;
  /** Panes whose pings/toasts are silenced (they still glow). */
  muted: Record<number, boolean>;
  /** Host whose connection-settings dialog is open. */
  settingsFor: string | null;
  settingsOpen: boolean;

  init(snapshot: CoreSnapshot): void;
  apply(ev: CoreEvent): void;
  notify(level: NoticeLevel, message: string, host?: string | null): void;
  dismiss(id: number): void;
  setFilter(filter: PaneFilter): void;
  setQuery(query: string): void;
  setFocusHost(host: string | null): void;
  setFocusLabel(label: string | null): void;
  setTileMenu(menu: TileMenuState | null): void;
  setExpanded(key: number | null): void;
  openNewPane(host: string | null, cwd?: string): void;
  closeNewPane(): void;
  setTerminating(key: number | null): void;
  setIntegrationFor(host: string | null): void;
  setMuted(key: number, muted: boolean): void;
  setSettingsFor(host: string | null): void;
  setSettingsOpen(open: boolean): void;
}

let noticeId = 1;

export const useApp = create<AppStore>((set) => ({
  ready: false,
  tailnet: null,
  config: {
    hosts: [],
    labels: [],
    sound: { enabled: true, volume: 0.7, finished: true, needsInput: true, subtask: true, bell: true, toasts: true },
    ui: { defaultFolders: {}, recording: false, hideMachineNames: false },
  },
  hosts: {},
  panes: {},
  attention: {},
  notices: [],
  filter: "all",
  query: "",
  focusHost: null,
  focusLabel: null,
  tileMenu: null,
  expanded: null,
  newPaneFor: undefined,
  newPaneCwd: null,
  terminating: null,
  integrationFor: null,
  muted: {},
  settingsFor: null,
  settingsOpen: false,

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
          migrateIdentities(st.panes[ev.host], ev.panes);
          return { panes: { ...st.panes, [ev.host]: ev.panes } };
        case "attention":
          return { attention: { ...st.attention, [ev.state.key]: ev.state } };
        case "notice":
          return { notices: [...st.notices, { id: noticeId++, host: ev.host, level: ev.level, message: ev.message }].slice(-6) };
        case "clipboard": {
          // A program in a pane copied something (OSC 52); the core only sends this while the
          // app is focused.
          const pane = Object.values(st.panes).flat().find((p) => p.key === ev.key);
          const text = ev.text;
          void navigator.clipboard
            .writeText(text)
            .then(() => useApp.getState().notify("info", `Copied ${text.length} character${text.length === 1 ? "" : "s"} from ${pane ? paneName(pane) : "a pane"}.`))
            .catch((e) => useApp.getState().notify("warning", `A pane tried to copy to the clipboard: ${e}`));
          return {};
        }
      }
    }),

  notify: (level, message, host = null) =>
    set((st) => ({ notices: [...st.notices, { id: noticeId++, host, level, message }].slice(-6) })),
  dismiss: (id) => set((st) => ({ notices: st.notices.filter((n) => n.id !== id) })),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setFocusHost: (focusHost) => set({ focusHost }),
  setFocusLabel: (focusLabel) => set({ focusLabel }),
  setTileMenu: (tileMenu) => set({ tileMenu }),
  setExpanded: (expanded) => set({ expanded }),
  openNewPane: (host, cwd) => set({ newPaneFor: host, newPaneCwd: cwd ?? null }),
  closeNewPane: () => set({ newPaneFor: undefined, newPaneCwd: null }),
  setTerminating: (terminating) => set({ terminating }),
  setIntegrationFor: (integrationFor) => set({ integrationFor }),
  setMuted: (key, muted) => set((st) => ({ muted: { ...st.muted, [key]: muted } })),
  setSettingsFor: (settingsFor) => set({ settingsFor }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
