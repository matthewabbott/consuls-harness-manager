// Layout preferences (panel sizes, collapsed state, active sidebar tab). Per device, so they
// live in localStorage rather than the core's config.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { GroupBy, SortBy } from "../lib/organize";

export type SidebarTab = "machines" | "files";

interface UiState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  filmstripWidth: number;
  filmstripCollapsed: boolean;
  composerHeight: number;
  /** Expanded view fills the window (side panels hidden). */
  maximized: boolean;
  groupBy: GroupBy;
  sortBy: SortBy;
  /** Pane identity → when it was last expanded (for "recently opened" sorting). */
  lastOpened: Record<string, number>;

  setSidebarWidth(w: number): void;
  toggleSidebar(): void;
  showSidebarTab(tab: SidebarTab): void;
  setFilmstripWidth(w: number): void;
  toggleFilmstrip(): void;
  setComposerHeight(h: number): void;
  setMaximized(m: boolean): void;
  setGroupBy(g: GroupBy): void;
  setSortBy(s: SortBy): void;
  markOpened(identity: string): void;
}

export const SIDEBAR = { min: 200, max: 480, default: 264 };
export const FILMSTRIP = { min: 200, max: 460, default: 288 };
export const COMPOSER = { min: 44, default: 76 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR.default,
      sidebarCollapsed: false,
      sidebarTab: "machines",
      filmstripWidth: FILMSTRIP.default,
      filmstripCollapsed: false,
      composerHeight: COMPOSER.default,
      maximized: false,
      groupBy: "machine",
      sortBy: "attention",
      lastOpened: {},

      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR.min, SIDEBAR.max) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      // Clicking the active tab collapses the sidebar (VS Code style); another tab opens it.
      showSidebarTab: (tab) =>
        set((s) => (s.sidebarTab === tab && !s.sidebarCollapsed ? { sidebarCollapsed: true } : { sidebarTab: tab, sidebarCollapsed: false })),
      setFilmstripWidth: (w) => set({ filmstripWidth: clamp(w, FILMSTRIP.min, FILMSTRIP.max) }),
      toggleFilmstrip: () => set((s) => ({ filmstripCollapsed: !s.filmstripCollapsed })),
      setComposerHeight: (h) => set({ composerHeight: clamp(h, COMPOSER.min, Math.max(COMPOSER.min, window.innerHeight * 0.5)) }),
      setMaximized: (maximized) => set({ maximized }),
      setGroupBy: (groupBy) => set({ groupBy }),
      setSortBy: (sortBy) => set({ sortBy }),
      markOpened: (identity) => set((s) => ({ lastOpened: { ...s.lastOpened, [identity]: Date.now() } })),
    }),
    {
      name: "consuls.ui.v1",
      storage: createJSONStorage(() => localStorage),
      // Maximize is a momentary view state, not a preference.
      partialize: ({ maximized: _m, ...rest }) => rest,
    },
  ),
);
