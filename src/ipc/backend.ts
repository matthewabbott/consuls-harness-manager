// The UI talks to the core through this interface: the Tauri implementation in the app,
// or a mock when the frontend runs in a plain browser (for design iteration).

import type { Alert } from "./bindings/Alert";
import type { AlertKind } from "./bindings/AlertKind";
import type { CoreEvent } from "./bindings/CoreEvent";
import type { FocusState } from "./bindings/FocusState";
import type { CoreSnapshot } from "./bindings/CoreSnapshot";
import type { DirListing } from "./bindings/DirListing";
import type { HostConfig } from "./bindings/HostConfig";
import type { IntegrationStatus } from "./bindings/IntegrationStatus";
import type { NewPaneSpec } from "./bindings/NewPaneSpec";
import type { ResizeOutcome } from "./bindings/ResizeOutcome";
import type { SoundPrefs } from "./bindings/SoundPrefs";
import type { TerminateOutcome } from "./bindings/TerminateOutcome";
import type { TailnetStatus } from "./bindings/TailnetStatus";

export interface Backend {
  readonly kind: "tauri" | "mock";
  getSnapshot(): Promise<CoreSnapshot>;
  onEvent(cb: (ev: CoreEvent) => void): Promise<() => void>;
  /** Alerts the shell surfaced (sound/toast) and toast clicks asking to open a pane. */
  onAlert(cb: (alert: Alert) => void): Promise<() => void>;
  onFocusPane(cb: (key: number) => void): Promise<() => void>;
  setFocus(focus: FocusState): Promise<void>;
  setSoundPrefs(prefs: SoundPrefs): Promise<void>;
  testChime(kind: AlertKind, volume: number): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  ackPane(key: number): Promise<void>;
  setPaneMuted(key: number, muted: boolean): Promise<void>;
  subscribeFrames(cb: (bytes: Uint8Array) => void): Promise<void>;
  upsertHost(config: HostConfig): Promise<void>;
  removeHost(id: string): Promise<void>;
  connectHost(id: string): Promise<void>;
  disconnectHost(id: string): Promise<void>;
  reconnectHost(id: string): Promise<void>;
  forgetHostKey(id: string): Promise<void>;
  refreshTailnet(): Promise<TailnetStatus>;
  openExternal(url: string): Promise<void>;
  setVisiblePanes(keys: number[] | null): Promise<void>;
  streamPane(key: number, on: boolean): Promise<void>;
  sendKeys(key: number, keys: string[]): Promise<void>;
  sendText(key: number, text: string): Promise<void>;
  pasteText(key: number, text: string): Promise<void>;
  submitPrompt(key: number, text: string): Promise<void>;
  createPane(spec: NewPaneSpec): Promise<number>;
  setPaneHidden(key: number, hidden: boolean): Promise<void>;
  resizePane(key: number, cols: number, rows: number): Promise<ResizeOutcome>;
  releasePaneSize(key: number): Promise<void>;
  terminatePane(key: number, force: boolean): Promise<TerminateOutcome>;
  listDir(host: string, path: string): Promise<DirListing>;
  integrationStatus(host: string): Promise<IntegrationStatus>;
  installIntegration(host: string): Promise<IntegrationStatus>;
  uninstallIntegration(host: string): Promise<IntegrationStatus>;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function toBytes(msg: unknown): Uint8Array {
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (ArrayBuffer.isView(msg)) return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
  if (Array.isArray(msg)) return Uint8Array.from(msg as number[]);
  return new Uint8Array();
}

async function tauriBackend(): Promise<Backend> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    kind: "tauri",
    getSnapshot: () => invoke("get_snapshot"),
    onEvent: async (cb) => listen<CoreEvent>("core-event", (e) => cb(e.payload)),
    onAlert: async (cb) => listen<Alert>("alert", (e) => cb(e.payload)),
    onFocusPane: async (cb) => listen<number>("focus-pane", (e) => cb(e.payload)),
    setFocus: (focus) => invoke("set_focus", { focus }),
    setSoundPrefs: (prefs) => invoke("set_sound_prefs", { prefs }),
    testChime: (kind, volume) => invoke("test_chime", { kind, volume }),
    setWindowTitle: async (title) => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTitle(title);
    },
    ackPane: (key) => invoke("ack_pane", { key }),
    setPaneMuted: (key, muted) => invoke("set_pane_muted", { key, muted }),
    subscribeFrames: async (cb) => {
      const channel = new Channel<unknown>((msg) => cb(toBytes(msg)));
      await invoke("subscribe_frames", { channel });
    },
    upsertHost: (config) => invoke("upsert_host", { config }),
    removeHost: (id) => invoke("remove_host", { id }),
    connectHost: (id) => invoke("connect_host", { id }),
    disconnectHost: (id) => invoke("disconnect_host", { id }),
    reconnectHost: (id) => invoke("reconnect_host", { id }),
    forgetHostKey: (id) => invoke("forget_host_key", { id }),
    refreshTailnet: () => invoke("refresh_tailnet"),
    openExternal: (url) => invoke("open_external", { url }),
    setVisiblePanes: (keys) => invoke("set_visible_panes", { keys }),
    streamPane: (key, on) => invoke("stream_pane", { key, on }),
    sendKeys: (key, keys) => invoke("send_keys", { key, keys }),
    sendText: (key, text) => invoke("send_text", { key, text }),
    pasteText: (key, text) => invoke("paste_text", { key, text }),
    submitPrompt: (key, text) => invoke("submit_prompt", { key, text }),
    createPane: (spec) => invoke("create_pane", { spec }),
    setPaneHidden: (key, hidden) => invoke("set_pane_hidden", { key, hidden }),
    resizePane: (key, cols, rows) => invoke("resize_pane", { key, cols, rows }),
    releasePaneSize: (key) => invoke("release_pane_size", { key }),
    terminatePane: (key, force) => invoke("terminate_pane", { key, force }),
    listDir: (host, path) => invoke("list_dir", { host, path }),
    integrationStatus: (host) => invoke("integration_status", { host }),
    installIntegration: (host) => invoke("install_integration", { host }),
    uninstallIntegration: (host) => invoke("uninstall_integration", { host }),
  };
}

let backendPromise: Promise<Backend> | null = null;

export function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = inTauri ? tauriBackend() : import("./mock").then((m) => m.mockBackend());
  }
  return backendPromise;
}
