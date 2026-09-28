// Recording mode's redactors, rebuilt from live data (tailnet, machines, config) whenever it or
// the mode changes. UI text goes through `useRedact()`; tiles and the expanded terminal read
// the current redactors directly.

import { create } from "zustand";

import { makeRedactor, type Redactor, type Secrets } from "../lib/redact";
import { baseName } from "../lib/paths";
import { repaintTiles } from "../term/tiles";
import { useApp } from "./app";

interface RecordingState {
  on: boolean;
  /** Masks UI text (identity while off). */
  ui: (s: string) => string;
  tile: Redactor | null;
  stream: Redactor | null;
}

const identity = (s: string) => s;

export const useRecording = create<RecordingState>(() => ({ on: false, ui: identity, tile: null, stream: null }));

/** The UI text masker: call it on anything personal that's rendered. */
export const useRedact = () => useRecording((s) => s.ui);

/** What to hide, from what the app knows right now. */
export function collectSecrets(app: ReturnType<typeof useApp.getState>, hideMachines: boolean): Secrets {
  const literals: string[] = [];
  const t = app.tailnet;
  const peers = t?.peers ?? [];
  if (t?.tailnetName) literals.push(t.tailnetName);
  if (t?.selfNode) {
    // This PC's own tailnet name is as personal as its Windows name.
    literals.push(t.selfNode.hostName, t.selfNode.dnsName, t.selfNode.id, ...t.selfNode.ips);
  }
  for (const p of peers) literals.push(p.dnsName, ...p.ips);
  for (const h of Object.values(app.hosts)) {
    const f = h.facts;
    if (f?.user) literals.push(f.user);
    if (f?.home) literals.push(baseName(f.home));
    // "Windows · DESKTOP-ABC123" → the PC's name.
    const pc = f?.uname.match(/^Windows · (.+)$/)?.[1];
    if (pc) literals.push(pc);
  }
  for (const c of app.config.hosts) {
    literals.push(c.user);
    if (c.address) literals.push(c.address);
  }
  // Each machine by all its names; configured ones first, so they're machine 1, 2, …
  const names = (id: string) => {
    const p = peers.find((x) => x.id === id);
    return p ? [id, p.hostName] : [id];
  };
  const machines = [...app.config.hosts.map((c) => c.id), ...Object.keys(app.hosts), ...peers.map((p) => p.id)]
    .filter((id, i, all) => !id.startsWith("@") && all.indexOf(id) === i)
    .map(names);
  return {
    literals: literals.filter((s) => s && !["home", "users", "root"].includes(s.toLowerCase())),
    machines: hideMachines ? machines : [],
  };
}

function rebuild() {
  const { recording, hideMachineNames } = useApp.getState().config.ui;
  const prev = useRecording.getState();
  if (!recording) {
    if (prev.on) useRecording.setState({ on: false, ui: identity, tile: null, stream: null });
  } else {
    const secrets = collectSecrets(useApp.getState(), hideMachineNames);
    const ui = makeRedactor(secrets, "ui");
    useRecording.setState({ on: true, ui: (s: string) => ui.text(s), tile: makeRedactor(secrets, "tile"), stream: makeRedactor(secrets, "stream") });
  }
  repaintTiles();
  document.documentElement.classList.toggle("recording", recording);
}

let started = false;

/** Keeps the redactors current; call once at startup. */
export function startRecordingMode() {
  if (started) return;
  started = true;
  rebuild();
  useApp.subscribe((s, p) => {
    const flags = s.config.ui.recording !== p.config.ui.recording || s.config.ui.hideMachineNames !== p.config.ui.hideMachineNames;
    if (flags || (s.config.ui.recording && (s.tailnet !== p.tailnet || s.hosts !== p.hosts || s.config !== p.config))) rebuild();
  });
}
