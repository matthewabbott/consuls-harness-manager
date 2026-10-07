// The iPhone app: machines and their agents, an agent's terminal with a composer, settings.
// The core runs inside the app (remote machines only); the app runs only while it's on screen.

import { useEffect, useMemo, useState } from "react";

import TerminateDialog from "../components/TerminateDialog";
import { backend, inWebApp } from "../ipc/backend";
import { setLocalLabel } from "../lib/hosts";
import { useApp } from "../store/app";
import { applyFrames } from "../term/tiles";
import AddMachineSheet from "./AddMachineSheet";
import MachinesScreen from "./MachinesScreen";
import NewSessionSheet from "./NewSessionSheet";
import FilesScreen from "./FilesScreen";
import { useFilesScreen } from "./files";
import Notices from "./Notices";
import PaneScreen from "./PaneScreen";
import SettingsScreen from "./SettingsScreen";

/**
 * Keeps `--visible-height` at the height above the keyboard: iOS overlays the keyboard on the
 * page instead of shrinking it, and pans the page to show the focused field. The page stays put
 * instead, sized to what's visible, and the field is scrolled into view within its sheet.
 */
function useVisibleHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const root = document.documentElement;
      root.style.setProperty("--visible-height", `${vv.height}px`);
      root.classList.toggle("keyboard", window.innerHeight - vv.height > 120);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    // The terminal keeps its own cursor line in view (PaneScreen).
    const reveal = () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || !el.matches("input, textarea") || el.closest(".terminal-frame")) return;
      el.scrollIntoView({ block: "nearest" });
    };
    const resized = () => {
      update();
      reveal();
    };
    // Moving to another field with the keyboard already up resizes nothing.
    const focused = () => window.setTimeout(reveal, 50);
    vv.addEventListener("resize", resized);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", focused);
    update();
    return () => {
      vv.removeEventListener("resize", resized);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", focused);
    };
  }, []);
}

/** `#pane=spark2/%3`, from a tapped notification (the server's own machine is `@local` here). */
function paneFromHash(): { host: string; paneId: string } | null {
  const m = window.location.hash.match(/^#pane=([^/]+)\/(.+)$/);
  return m ? { host: decodeURIComponent(m[1]), paneId: decodeURIComponent(m[2]) } : null;
}

/** Opens the pane a tapped notification points at, once it's listed. */
function useOpenFromNotification() {
  const ready = useApp((s) => s.ready);
  const panes = useApp((s) => s.panes);
  const selfName = useApp((s) => s.tailnet?.selfNode?.id ?? null);
  const [target, setTarget] = useState(paneFromHash);
  useEffect(() => {
    const onHash = () => setTarget(paneFromHash());
    // The service worker focuses the open app and says where to go.
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open") window.location.hash = new URL(e.data.url, location.href).hash;
    };
    window.addEventListener("hashchange", onHash);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("hashchange", onHash);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, []);
  useEffect(() => {
    if (!target || !ready) return;
    const pane = Object.values(panes)
      .flat()
      .find((p) => p.tmux?.paneId === target.paneId && (p.host === target.host || (p.host === "@local" && target.host === selfName)));
    if (!pane) return;
    useApp.getState().setExpanded(pane.key);
    setTarget(null);
    history.replaceState(null, "", location.pathname);
  }, [target, ready, panes, selfName]);
}

export default function App() {
  const ready = useApp((s) => s.ready);
  const expanded = useApp((s) => s.expanded);
  const panes = useApp((s) => s.panes);
  const terminating = useApp((s) => s.terminating);
  const [screen, setScreen] = useState<"machines" | "settings">("machines");
  const [adding, setAdding] = useState(false);
  // The machine a new session is being started on; undefined: no sheet.
  const [newOn, setNewOn] = useState<string | null | undefined>(undefined);
  const filesAt = useFilesScreen((s) => s.at);
  const pane = useMemo(() => (expanded === null ? null : (Object.values(panes).flat().find((p) => p.key === expanded) ?? null)), [expanded, panes]);
  useVisibleHeight();
  useOpenFromNotification();
  // The web app's server watches its own machine as `@local`: name it after the machine.
  const selfName = useApp((s) => s.tailnet?.selfNode?.id);
  useEffect(() => {
    if (inWebApp && selfName) setLocalLabel(selfName);
  }, [selfName]);

  // The pane on screen went away (closed elsewhere): back to the list.
  useEffect(() => {
    if (expanded !== null && ready && !pane) useApp.getState().setExpanded(null);
  }, [expanded, pane, ready]);

  // Tell the core what's on screen: looking at a waiting agent marks it seen (so no push).
  useEffect(() => {
    const report = () => backend().then((b) => b.setFocus({ expanded: useApp.getState().expanded, windowFocused: !document.hidden }));
    document.addEventListener("visibilitychange", report);
    const unsub = useApp.subscribe((s, prev) => {
      if (s.expanded !== prev.expanded) report();
    });
    report();
    return () => {
      document.removeEventListener("visibilitychange", report);
      unsub();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const b = await backend();
      // Subscribe before snapshotting so no event is missed; duplicates are harmless.
      unlisten = await b.onEvent((ev) => useApp.getState().apply(ev));
      const snapshot = await b.getSnapshot();
      if (cancelled) return;
      useApp.getState().init(snapshot);
      // The list draws no live tiles; only the open pane streams.
      await b.setVisiblePanes([]);
      await b.subscribeFrames(applyFrames);
      if (b.kind === "mock") useApp.getState().notify("info", "Mock data: not inside the app.");
      // The web app's connection came back (or events were missed): read everything again.
      if (inWebApp) {
        const { useConnection } = await import("../ipc/webBackend");
        const unsub = useConnection.subscribe((s, prev) => {
          if (s.epoch > prev.epoch) void b.getSnapshot().then((snap) => useApp.getState().init(snap));
        });
        const before = unlisten;
        unlisten = () => {
          before?.();
          unsub();
        };
      }
    })().catch((e) => useApp.getState().notify("error", `Failed to start: ${e}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-ink-900">
      {!ready ? (
        <div className="flex-1" />
      ) : pane ? (
        <PaneScreen pane={pane} onBack={() => useApp.getState().setExpanded(null)} />
      ) : screen === "settings" ? (
        <SettingsScreen onBack={() => setScreen("machines")} onAdd={() => setAdding(true)} />
      ) : (
        <MachinesScreen onSettings={() => setScreen("settings")} onAdd={() => setAdding(true)} onNew={setNewOn} />
      )}
      {adding && <AddMachineSheet onClose={() => setAdding(false)} />}
      {newOn !== undefined && <NewSessionSheet host={newOn} onClose={() => setNewOn(undefined)} />}
      {filesAt && <FilesScreen key={`${filesAt.host}\n${filesAt.dir}\n${filesAt.file?.path ?? ""}`} at={filesAt} onClose={useFilesScreen.getState().close} />}
      {/* The tmux prefix's x (close this pane) asks first. */}
      {terminating !== null && <TerminateDialog paneKey={terminating} />}
      <Notices />
    </div>
  );
}
