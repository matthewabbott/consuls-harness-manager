// The iPhone app: machines and their agents, an agent's terminal with a composer, settings.
// The core runs inside the app (remote machines only); the app runs only while it's on screen.

import { useEffect, useMemo, useState } from "react";

import TerminateDialog from "../components/TerminateDialog";
import { backend } from "../ipc/backend";
import { useApp } from "../store/app";
import { applyFrames } from "../term/tiles";
import AddMachineSheet from "./AddMachineSheet";
import MachinesScreen from "./MachinesScreen";
import Notices from "./Notices";
import PaneScreen from "./PaneScreen";
import SettingsScreen from "./SettingsScreen";

/**
 * Keeps `--visible-height` at the height above the keyboard: iOS overlays the keyboard on the
 * page instead of shrinking it, and pans the page to show the focused field.
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
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
}

export default function App() {
  const ready = useApp((s) => s.ready);
  const expanded = useApp((s) => s.expanded);
  const panes = useApp((s) => s.panes);
  const terminating = useApp((s) => s.terminating);
  const [screen, setScreen] = useState<"machines" | "settings">("machines");
  const [adding, setAdding] = useState(false);
  const pane = useMemo(() => (expanded === null ? null : (Object.values(panes).flat().find((p) => p.key === expanded) ?? null)), [expanded, panes]);
  useVisibleHeight();

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
        <MachinesScreen onSettings={() => setScreen("settings")} onAdd={() => setAdding(true)} />
      )}
      {adding && <AddMachineSheet onClose={() => setAdding(false)} />}
      {/* The tmux prefix's x (close this pane) asks first. */}
      {terminating !== null && <TerminateDialog paneKey={terminating} />}
      <Notices />
    </div>
  );
}
