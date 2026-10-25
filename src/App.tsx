import { useEffect, useMemo, useState } from "react";

import Banners from "./components/Banners";
import HostSettingsDialog from "./components/HostSettingsDialog";
import IntegrationDialog from "./components/IntegrationDialog";
import NewPaneDialog from "./components/NewPaneDialog";
import SettingsDialog from "./components/SettingsDialog";
import DragGhost from "./components/DragGhost";
import TileMenu from "./components/TileMenu";
import Modal, { Button } from "./components/Modal";
import { displayTitle, paneIdentity } from "./lib/panes";
import { appMod, isMac, keyLabel } from "./lib/platform";
import { assignLabel, jumpLabel } from "./lib/hotkeys";
import TerminateDialog from "./components/TerminateDialog";
import Grid from "./components/Grid";
import Notices from "./components/Notices";
import LeftSidebar from "./components/LeftSidebar";
import TopBar from "./components/TopBar";
import { backend } from "./ipc/backend";
import { useApp } from "./store/app";
import { migrateLocalDefaults } from "./store/prefs";
import { startRecordingMode } from "./store/recording";
import { useUi } from "./store/ui";
import { applyFrames } from "./term/tiles";
import Workspace from "./components/Workspace";
import { useEditor } from "./store/editor";
import { hotkeyAction } from "./lib/hotkeys";
import { fileTarget, leafOf, leaves, paneTarget } from "./lib/layoutTree";
import { fileOf, paneOf, useLayout, visiblePanes } from "./store/layout";
import { useHotkeys } from "./store/hotkeys";
import { useWindows } from "./store/windows";

export const APP_TITLE = "Consul's Harness Manager";

export default function App() {
  const ready = useApp((s) => s.ready);
  const expanded = useApp((s) => s.expanded);
  const panes = useApp((s) => s.panes);
  const newPaneFor = useApp((s) => s.newPaneFor);
  const terminating = useApp((s) => s.terminating);
  const integrationFor = useApp((s) => s.integrationFor);
  const settingsFor = useApp((s) => s.settingsFor);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const tileMenu = useApp((s) => s.tileMenu);
  const grid = useLayout((s) => s.grid || !s.root);
  const kept = useLayout((s) => (s.grid && s.root ? leaves(s.root).length : 0));
  const previous = useLayout((s) => (s.previous ? leaves(s.previous).length : 0));
  const [quitAsk, setQuitAsk] = useState<number | null>(null);
  const expandedPane = useMemo(
    () => (expanded === null ? null : (Object.values(panes).flat().find((p) => p.key === expanded) ?? null)),
    [expanded, panes],
  );

  // Open files keep being checked for outside changes.
  useEffect(() => {
    const t = window.setInterval(() => void useEditor.getState().poll(), 15_000);
    return () => window.clearInterval(t);
  }, []);

  // Remember when each pane was last opened (for "recently opened" sorting).
  useEffect(() => {
    if (expandedPane) useUi.getState().markOpened(paneIdentity(expandedPane));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedPane?.key]);

  // Maximize belongs to a split on screen: the grid, or the maximized split closing, ends it.
  const zoomGone = useLayout((s) => s.zoomed === null && !!s.root && leaves(s.root).length > 1);
  useEffect(() => {
    if ((grid || zoomGone) && useUi.getState().maximized) useUi.getState().setMaximized(false);
  }, [grid, zoomGone]);

  // Tell the core what the user is looking at (it decides ping/toast/ack from this), and the
  // other windows what this one shows.
  useEffect(() => {
    const report = () => {
      const layout = useLayout.getState();
      const shown = !document.hidden;
      const visible = shown ? visiblePanes(layout).map((p) => p.key) : [];
      const targets = layout.grid ? [] : leaves(layout.root).flatMap((l) => (l.target ? [l.target] : []));
      void backend().then((b) =>
        b.setFocus({ expanded: shown ? useApp.getState().expanded : null, windowFocused: document.hasFocus() && shown, visible }, targets),
      );
    };
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    const unsub = useApp.subscribe((s, prev) => {
      if (s.expanded !== prev.expanded) report();
    });
    const unsubLayout = useLayout.subscribe((s, prev) => {
      if (s.root !== prev.root || s.grid !== prev.grid || s.zoomed !== prev.zoomed) report();
    });
    report();
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
      unsub();
      unsubLayout();
    };
  }, []);

  // Hotkeys: ⌘digit jumps, ⌘⌥digit assigns (Ctrl / Ctrl+Shift elsewhere). Caught before the
  // terminal or editor sees the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = hotkeyAction(e, isMac);
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const st = useApp.getState();
      const layout = useLayout.getState();
      if (action.kind === "assign") {
        const leaf = layout.grid ? undefined : leaves(layout.root).find((l) => l.id === layout.focused);
        if (!leaf?.target) return st.notify("info", "Open a pane or a file first, then give it a hotkey.");
        const was = useHotkeys.getState().keys[action.digit];
        useHotkeys.getState().assign(action.digit, leaf.target);
        const now = useHotkeys.getState().keys[action.digit];
        const name = describe(leaf.target);
        st.notify("info", now ? `${jumpLabel(action.digit)} → ${name}` : was ? `${jumpLabel(action.digit)} no longer jumps to ${name}` : "");
        return;
      }
      const target = useHotkeys.getState().keys[action.digit];
      if (!target) return st.notify("info", `Nothing on ${jumpLabel(action.digit)} yet: ${assignLabel(action.digit)} gives it to what has focus.`);
      jumpTo(target);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Window title shows how many panes are waiting.
  const attention = useApp((s) => s.attention);
  useEffect(() => {
    const n = Object.values(attention).filter((a) => a.attention === "unacked").length;
    const title = n > 0 ? `(${n}) ${APP_TITLE}` : APP_TITLE;
    document.title = title;
    // The native window title doesn't follow document.title in Tauri.
    backend().then((b) => b.setWindowTitle(title).catch(() => {}));
  }, [attention]);

  // The page itself must never zoom, reload or print (those keys belong to the terminal/app).
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    // Runs after the terminal/composer have handled the key (bubbling), so it only stops the
    // WebView's own zoom / print / reload, never the keystroke itself.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && ["=", "+", "-", "_", "0", "p"].includes(k)) e.preventDefault();
      // Reload stays available while developing.
      if (!import.meta.env.DEV && ((mod && k === "r") || e.key === "F5")) e.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Global shortcuts (⌘ on macOS, Ctrl elsewhere): Mod+Shift+G back to grid, Mod+Shift+Space jump
  // to the next waiting pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = appMod(e);
      // Mod+Shift+G: to the grid, and back to the splits.
      if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        const layout = useLayout.getState();
        if (layout.grid) layout.toLayout();
        else {
          useUi.getState().setMaximized(false);
          layout.toGrid();
        }
      }
      // Mod+Shift+B toggles the sidebar (plain Ctrl+B is tmux's prefix, so it stays with the pane).
      if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useUi.getState().toggleSidebar();
      }
      // Ctrl+Shift+N: a new window (macOS has Window → New Window, ⌘⇧N).
      if (!isMac && mod && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void backend().then((b) => b.openWindow());
      }
      if (mod && e.shiftKey && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        const st = useApp.getState();
        const live = new Set(Object.values(st.panes).flat().filter((p) => !p.hidden).map((p) => p.key));
        const waiting = Object.values(st.attention)
          .filter((a) => live.has(a.key) && a.key !== st.expanded && (a.activity === "idle" || a.activity === "needsInput") && a.attention !== "none")
          .sort((a, b) => Number(b.attention === "unacked") - Number(a.attention === "unacked") || a.since - b.since);
        if (waiting[0]) {
          backend().then((b) => b.ackPane(waiting[0].key));
          st.setExpanded(waiting[0].key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    startRecordingMode();
    (async () => {
      const b = await backend();
      // Subscribe before snapshotting so no event is missed; duplicates are harmless.
      unlisten = await b.onEvent((ev) => useApp.getState().apply(ev));
      const unFocus = await b.onFocusPane((key) => useApp.getState().setExpanded(key));
      const unQuit = await b.onConfirmQuit(setQuitAsk);
      const unTarget = await b.onFocusTarget((target) => useLayout.getState().show(target));
      const prevUnlisten = unlisten;
      unlisten = () => {
        prevUnlisten();
        unFocus();
        unQuit();
        unTarget();
      };
      const snapshot = await b.getSnapshot();
      if (cancelled) return;
      useApp.getState().init(snapshot);
      migrateLocalDefaults();
      // Unsaved editor buffers from last time.
      void useEditor.getState().restoreDrafts();
      await b.subscribeFrames(applyFrames);
      if (b.kind === "mock") useApp.getState().notify("info", "Running with mock data (not inside the desktop app).");
    })().catch((e) => useApp.getState().notify("error", `Failed to start: ${e}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="app-backdrop flex h-full">
      <LeftSidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {grid && <TopBar />}
        {grid && (kept > 0 || previous > 0) && (
          <div className="-mt-2 mb-1 flex gap-2 px-6">
            {kept > 0 && (
              <button
                onClick={() => useLayout.getState().toLayout()}
                className="rounded-full bg-sky-400/10 px-3 py-1 text-[12px] text-sky-300 ring-1 ring-sky-400/30 hover:bg-sky-400/20"
              >
                Back to {kept === 1 ? "the open pane" : `your ${kept} splits`} ({keyLabel("Mod+Shift+G")})
              </button>
            )}
          </div>
        )}
        {!grid && previous > 0 && (
          <div className="absolute top-2 right-6 z-20">
            <button
              onClick={() => useLayout.getState().restorePrevious()}
              className="rounded-full bg-ink-800/90 px-3 py-1 text-[12px] text-sky-300 ring-1 ring-sky-400/30 backdrop-blur hover:bg-ink-700"
            >
              Restore the {previous} splits
            </button>
          </div>
        )}
        <Banners />
        {!ready ? <div className="flex-1" /> : grid ? <Grid /> : <Workspace />}
      </main>
      <Notices />
      {newPaneFor !== undefined && <NewPaneDialog />}
      {terminating !== null && <TerminateDialog paneKey={terminating} />}
      {integrationFor !== null && <IntegrationDialog host={integrationFor} />}
      {settingsFor !== null && <HostSettingsDialog host={settingsFor} />}
      {settingsOpen && <SettingsDialog />}
      {tileMenu && <TileMenu menu={tileMenu} onClose={() => useApp.getState().setTileMenu(null)} />}
      <DragGhost />
      {quitAsk !== null && (
        <Modal
          title="Quit Harness Manager?"
          onClose={() => setQuitAsk(null)}
          width={420}
          footer={
            <>
              <Button onClick={() => setQuitAsk(null)}>Keep running</Button>
              <Button kind="danger" onClick={() => backend().then((b) => b.quitApp())}>
                Quit
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-mist-300">
            {quitAsk === 1 ? "A shell on this PC is" : `${quitAsk} shells on this PC are`} still running. Quitting ends{" "}
            {quitAsk === 1 ? "it" : "them"} (and anything running inside). Closing the window instead keeps everything running in the
            tray.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** What a layout target is called (a pane's title, a file's name). */
function describe(target: string): string {
  const pane = paneOf(target);
  if (pane) return displayTitle(pane);
  const file = fileOf(target);
  return file ? (file.split("/").pop() ?? file) : "it";
}

/**
 * Brings `target` (a hotkey's) on screen: where this window shows it, else where another window
 * does, else here (in the focused split, or alone from the grid).
 */
function jumpTo(target: string) {
  const layout = useLayout.getState();
  if (!layout.grid && leafOf(layout.root, target)) return layout.show(target);
  const elsewhere = useWindows.getState().views.find((v) => !v.mine && v.targets.includes(target));
  if (elsewhere) return void backend().then((b) => b.focusWindow(elsewhere.label, target));
  const file = fileOf(target);
  if (file) {
    const [host, path] = file.split("\n");
    if (!useEditor.getState().files[file]) void useEditor.getState().open(host, path, null, undefined, false);
    return layout.show(fileTarget(file));
  }
  const pane = paneOf(target);
  if (!pane) return useApp.getState().notify("info", "That pane isn't here right now (closed, or its machine is offline).");
  backend().then((b) => b.ackPane(pane.key));
  layout.show(paneTarget(paneIdentity(pane)));
}
