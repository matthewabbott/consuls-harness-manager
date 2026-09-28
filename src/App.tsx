import { useEffect, useMemo, useState } from "react";

import Banners from "./components/Banners";
import ExpandedPane from "./components/ExpandedPane";
import HostSettingsDialog from "./components/HostSettingsDialog";
import IntegrationDialog from "./components/IntegrationDialog";
import NewPaneDialog from "./components/NewPaneDialog";
import SettingsDialog from "./components/SettingsDialog";
import DragGhost from "./components/DragGhost";
import TileMenu from "./components/TileMenu";
import Modal, { Button } from "./components/Modal";
import { paneIdentity } from "./lib/panes";
import TerminateDialog from "./components/TerminateDialog";
import Grid from "./components/Grid";
import Notices from "./components/Notices";
import LeftSidebar from "./components/LeftSidebar";
import TopBar from "./components/TopBar";
import { backend } from "./ipc/backend";
import { useApp } from "./store/app";
import { useUi } from "./store/ui";
import { applyFrames } from "./term/tiles";
import FileView from "./components/FileView";
import { useEditor } from "./store/editor";

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
  const activeFile = useEditor((s) => s.active);
  const [quitAsk, setQuitAsk] = useState<number | null>(null);
  const expandedPane = useMemo(
    () => (expanded === null ? null : (Object.values(panes).flat().find((p) => p.key === expanded) ?? null)),
    [expanded, panes],
  );

  // Opening a pane takes over from an open file; files keep being checked for outside changes.
  useEffect(() => {
    const unsub = useApp.subscribe((s, prev) => {
      if (s.expanded !== null && s.expanded !== prev.expanded) useEditor.getState().setActive(null);
    });
    const t = window.setInterval(() => void useEditor.getState().poll(), 15_000);
    return () => {
      unsub();
      window.clearInterval(t);
    };
  }, []);

  // Remember when each pane was last opened (for "recently opened" sorting).
  useEffect(() => {
    if (expandedPane) useUi.getState().markOpened(paneIdentity(expandedPane));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedPane?.key]);

  // If the expanded pane disappears (closed remotely), fall back to the grid.
  useEffect(() => {
    if (expanded !== null && ready && !expandedPane) useApp.getState().setExpanded(null);
  }, [expanded, expandedPane, ready]);

  // Maximize belongs to the pane on screen: a file opened over it, or the grid, ends it.
  const paneShowing = !!expandedPane && !activeFile;
  useEffect(() => {
    if (!paneShowing && useUi.getState().maximized) useUi.getState().setMaximized(false);
  }, [paneShowing]);

  // Tell the core what the user is looking at: it decides ping/toast/ack from this.
  useEffect(() => {
    const report = () =>
      backend().then((b) => b.setFocus({ expanded: useApp.getState().expanded, windowFocused: document.hasFocus() && !document.hidden }));
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    const unsub = useApp.subscribe((s, prev) => {
      if (s.expanded !== prev.expanded) report();
    });
    report();
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
      unsub();
    };
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

  // Global shortcuts: Ctrl+Shift+G back to grid, Ctrl+Shift+Space jump to the next waiting pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        useEditor.getState().setActive(null);
        useApp.getState().setExpanded(null);
      }
      // Ctrl+Shift+B toggles the sidebar (plain Ctrl+B is tmux's prefix, so it stays with the pane).
      if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useUi.getState().toggleSidebar();
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
    (async () => {
      const b = await backend();
      // Subscribe before snapshotting so no event is missed; duplicates are harmless.
      unlisten = await b.onEvent((ev) => useApp.getState().apply(ev));
      const unFocus = await b.onFocusPane((key) => useApp.getState().setExpanded(key));
      const unQuit = await b.onConfirmQuit(setQuitAsk);
      const prevUnlisten = unlisten;
      unlisten = () => {
        prevUnlisten();
        unFocus();
        unQuit();
      };
      const snapshot = await b.getSnapshot();
      if (cancelled) return;
      useApp.getState().init(snapshot);
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
      <main className="flex min-w-0 flex-1 flex-col">
        {!expandedPane && !activeFile && <TopBar />}
        <Banners />
        {!ready ? (
          <div className="flex-1" />
        ) : activeFile ? (
          <FileView id={activeFile} />
        ) : expandedPane ? (
          <ExpandedPane pane={expandedPane} />
        ) : (
          <Grid />
        )}
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
