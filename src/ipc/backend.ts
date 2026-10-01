// The UI talks to the core through this interface: the Tauri implementation in the app,
// or a mock when the frontend runs in a plain browser (for design iteration).

import type { Alert } from "./bindings/Alert";
import type { AlertKind } from "./bindings/AlertKind";
import type { CoreEvent } from "./bindings/CoreEvent";
import type { FocusState } from "./bindings/FocusState";
import type { CoreSnapshot } from "./bindings/CoreSnapshot";
import type { DirListing } from "./bindings/DirListing";
import type { DriveInfo } from "./bindings/DriveInfo";
import type { HostConfig } from "./bindings/HostConfig";
import type { IntegrationStatus } from "./bindings/IntegrationStatus";
import type { LabelDef } from "./bindings/LabelDef";
import type { LocalShell } from "./bindings/LocalShell";
import type { FsOp } from "./bindings/FsOp";
import type { GitStatus } from "./bindings/GitStatus";
import type { FileContent } from "./bindings/FileContent";
import type { FileStamp } from "./bindings/FileStamp";
import type { HeadVersion } from "./bindings/HeadVersion";
import type { NewPaneSpec } from "./bindings/NewPaneSpec";
import type { NotifyMode } from "./bindings/NotifyMode";
import type { NotifyPrefs } from "./bindings/NotifyPrefs";
import type { ResizeOutcome } from "./bindings/ResizeOutcome";
import type { SoundPrefs } from "./bindings/SoundPrefs";
import type { TerminateOutcome } from "./bindings/TerminateOutcome";
import type { TmuxOp } from "./bindings/TmuxOp";
import type { TailnetStatus } from "./bindings/TailnetStatus";
import type { UiPrefs } from "./bindings/UiPrefs";

export interface Backend {
  readonly kind: "tauri" | "mock" | "web";
  getSnapshot(): Promise<CoreSnapshot>;
  onEvent(cb: (ev: CoreEvent) => void): Promise<() => void>;
  /** Alerts the shell surfaced (sound/toast) and toast clicks asking to open a pane. */
  onAlert(cb: (alert: Alert) => void): Promise<() => void>;
  onFocusPane(cb: (key: number) => void): Promise<() => void>;
  /** Tray → Quit while shells on this PC are running: ask, then call quitApp. */
  onConfirmQuit(cb: (liveShells: number) => void): Promise<() => void>;
  quitApp(): Promise<void>;
  localShells(): Promise<LocalShell[]>;
  /** Drives on this PC (Windows; empty elsewhere). */
  localDrives(): Promise<DriveInfo[]>;
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
  /** Shows a file or folder on This PC in File Explorer / Finder. */
  revealPath(host: string, path: string): Promise<void>;
  vscodeStatus(): Promise<VsCodeStatus>;
  /** Opens a file (at a line) or folder in VS Code; other machines go through Remote-SSH. */
  openInVscode(host: string, path: string, line?: number, col?: number): Promise<void>;
  /** The UI's per-device state (see lib/uiState.ts). */
  getUiState(): Promise<Record<string, string>>;
  setUiState(key: string, value: string | null): Promise<void>;
  /** Default folders and recording mode (kept in the core's config; comes back as a Config event). */
  setUiPrefs(prefs: UiPrefs): Promise<void>;
  setVisiblePanes(keys: number[] | null): Promise<void>;
  streamPane(key: number, on: boolean): Promise<void>;
  sendKeys(key: number, keys: string[]): Promise<void>;
  sendText(key: number, text: string): Promise<void>;
  pasteText(key: number, text: string): Promise<void>;
  /** Raw terminal input in xterm's own encoding (direct panes). */
  sendInput(key: number, data: string): Promise<void>;
  /** `images`: paths on the pane's machine (from savePaste), pasted before the text. */
  submitPrompt(key: number, text: string, images?: string[]): Promise<void>;
  /** Saves a pasted image on the machine (a week-long cache) and returns its path. */
  savePaste(host: string, bytes: Uint8Array, ext: string): Promise<string>;
  createPane(spec: NewPaneSpec): Promise<number>;
  setPaneHidden(key: number, hidden: boolean): Promise<void>;
  createLabel(name: string, color: string): Promise<LabelDef>;
  updateLabel(label: LabelDef): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  setPaneLabels(key: number, labels: string[]): Promise<void>;
  /** Name a pane (shown in Consuls only); null (or blank) clears it. */
  renamePane(key: number, name: string | null): Promise<void>;
  /** Ping on the pane's terminal bell; null = default (on for irssi, weechat, …). */
  setPaneBell(key: number, bell: boolean | null): Promise<void>;
  /** Push to the phone for this pane (`null`: don't track it). */
  setPaneNotify(key: number, mode: NotifyMode | null): Promise<void>;
  /** The server's push settings: delays and a pause (the web app only). */
  setNotifyPrefs(prefs: NotifyPrefs): Promise<void>;
  resizePane(key: number, cols: number, rows: number): Promise<ResizeOutcome>;
  releasePaneSize(key: number): Promise<void>;
  terminatePane(key: number, force: boolean): Promise<TerminateOutcome>;
  /** tmux's own window operations on a tmux pane; resolves to the new pane's key, if any. */
  tmuxOp(key: number, op: TmuxOp): Promise<number | null>;
  listDir(host: string, path: string): Promise<DirListing>;
  fsOp(host: string, op: FsOp): Promise<void>;
  /** Items a delete of `path` would remove (capped at 100,000 + 1). */
  fsCount(host: string, path: string): Promise<number>;
  gitStatus(host: string, dir: string): Promise<GitStatus | null>;
  readFile(host: string, path: string): Promise<FileContent>;
  /** The file's committed version, for the editor's change gutter. */
  gitHead(host: string, path: string): Promise<HeadVersion>;
  /** Raw bytes (image preview, up to 20 MB). */
  readBytes(host: string, path: string): Promise<ArrayBuffer>;
  statFile(host: string, path: string): Promise<FileStamp | null>;
  /** Rejects with a SaveError ({ kind: "conflict" | "failed" }). `expect: null` overwrites. */
  writeFile(host: string, path: string, text: string, bom: boolean, expect: FileStamp | null): Promise<FileStamp>;
  integrationStatus(host: string): Promise<IntegrationStatus>;
  installIntegration(host: string): Promise<IntegrationStatus>;
  uninstallIntegration(host: string): Promise<IntegrationStatus>;
}

/** From the app shell (not the core, so not in bindings/). */
export interface VsCodeStatus {
  installed: boolean;
  remoteSsh: boolean;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function toBytes(msg: unknown): Uint8Array {
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (ArrayBuffer.isView(msg)) return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
  if (Array.isArray(msg)) return Uint8Array.from(msg as number[]);
  return new Uint8Array();
}

/** A call into the core: a Tauri command in the desktop app, a WebSocket call in the web app. */
export type Call = <T>(method: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The core's commands, the same for every backend (the server mirrors them: crates/chm-daemon/src/
 * rpc.rs). What reaches the shell itself (windows, files on this PC, binary bodies) is added by
 * each backend.
 */
export function commands(call: Call) {
  return {
    getSnapshot: () => call<CoreSnapshot>("get_snapshot"),
    quitApp: () => call<void>("quit_app"),
    localShells: () => call<LocalShell[]>("local_shells"),
    localDrives: () => call<DriveInfo[]>("local_drives"),
    setFocus: (focus: FocusState) => call<void>("set_focus", { focus }),
    setSoundPrefs: (prefs: SoundPrefs) => call<void>("set_sound_prefs", { prefs }),
    testChime: (kind: AlertKind, volume: number) => call<void>("test_chime", { kind, volume }),
    ackPane: (key: number) => call<void>("ack_pane", { key }),
    setPaneMuted: (key: number, muted: boolean) => call<void>("set_pane_muted", { key, muted }),
    upsertHost: (config: HostConfig) => call<void>("upsert_host", { config }),
    removeHost: (id: string) => call<void>("remove_host", { id }),
    connectHost: (id: string) => call<void>("connect_host", { id }),
    disconnectHost: (id: string) => call<void>("disconnect_host", { id }),
    reconnectHost: (id: string) => call<void>("reconnect_host", { id }),
    forgetHostKey: (id: string) => call<void>("forget_host_key", { id }),
    refreshTailnet: () => call<TailnetStatus>("refresh_tailnet"),
    openExternal: (url: string) => call<void>("open_external", { url }),
    revealPath: (host: string, path: string) => call<void>("reveal_path", { host, path }),
    vscodeStatus: () => call<VsCodeStatus>("vscode_status"),
    openInVscode: (host: string, path: string, line?: number, col?: number) => call<void>("open_in_vscode", { host, path, line: line ?? null, col: col ?? null }),
    setUiPrefs: (prefs: UiPrefs) => call<void>("set_ui_prefs", { prefs }),
    setVisiblePanes: (keys: number[] | null) => call<void>("set_visible_panes", { keys }),
    streamPane: (key: number, on: boolean) => call<void>("stream_pane", { key, on }),
    sendKeys: (key: number, keys: string[]) => call<void>("send_keys", { key, keys }),
    sendText: (key: number, text: string) => call<void>("send_text", { key, text }),
    pasteText: (key: number, text: string) => call<void>("paste_text", { key, text }),
    sendInput: (key: number, data: string) => call<void>("send_input", { key, data }),
    submitPrompt: (key: number, text: string, images?: string[]) => call<void>("submit_prompt", { key, text, images: images ?? [] }),
    getUiState: () => call<Record<string, string>>("get_ui_state"),
    setUiState: (key: string, value: string | null) => call<void>("set_ui_state", { key, value }),
    createPane: (spec: NewPaneSpec) => call<number>("create_pane", { spec }),
    setPaneHidden: (key: number, hidden: boolean) => call<void>("set_pane_hidden", { key, hidden }),
    createLabel: (name: string, color: string) => call<LabelDef>("create_label", { name, color }),
    updateLabel: (label: LabelDef) => call<void>("update_label", { label }),
    deleteLabel: (id: string) => call<void>("delete_label", { id }),
    setPaneLabels: (key: number, labels: string[]) => call<void>("set_pane_labels", { key, labels }),
    renamePane: (key: number, name: string | null) => call<void>("rename_pane", { key, name }),
    tmuxOp: (key: number, op: TmuxOp) => call<number | null>("tmux_op", { key, op }),
    setPaneBell: (key: number, bell: boolean | null) => call<void>("set_pane_bell", { key, bell }),
    setPaneNotify: (key: number, mode: NotifyMode | null) => call<void>("set_pane_notify", { key, mode }),
    setNotifyPrefs: (prefs: NotifyPrefs) => call<void>("set_notify_prefs", { prefs }),
    resizePane: (key: number, cols: number, rows: number) => call<ResizeOutcome>("resize_pane", { key, cols, rows }),
    releasePaneSize: (key: number) => call<void>("release_pane_size", { key }),
    terminatePane: (key: number, force: boolean) => call<TerminateOutcome>("terminate_pane", { key, force }),
    listDir: (host: string, path: string) => call<DirListing>("list_dir", { host, path }),
    fsOp: (host: string, op: FsOp) => call<void>("fs_op", { host, op }),
    fsCount: (host: string, path: string) => call<number>("fs_count", { host, path }),
    gitStatus: (host: string, dir: string) => call<GitStatus | null>("git_status", { host, dir }),
    readFile: (host: string, path: string) => call<FileContent>("read_file", { host, path }),
    gitHead: (host: string, path: string) => call<HeadVersion>("git_head", { host, path }),
    readBytes: (host: string, path: string) => call<ArrayBuffer>("read_bytes", { host, path }),
    statFile: (host: string, path: string) => call<FileStamp | null>("stat_file", { host, path }),
    writeFile: (host: string, path: string, text: string, bom: boolean, expect: FileStamp | null) =>
      call<FileStamp>("write_file", { host, path, text, bom, expect }),
    integrationStatus: (host: string) => call<IntegrationStatus>("integration_status", { host }),
    installIntegration: (host: string) => call<IntegrationStatus>("install_integration", { host }),
    uninstallIntegration: (host: string) => call<IntegrationStatus>("uninstall_integration", { host }),
  };
}

async function tauriBackend(): Promise<Backend> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    kind: "tauri",
    ...commands((method, args) => invoke(method, args)),
    onEvent: async (cb) => listen<CoreEvent>("core-event", (e) => cb(e.payload)),
    onAlert: async (cb) => listen<Alert>("alert", (e) => cb(e.payload)),
    onFocusPane: async (cb) => listen<number>("focus-pane", (e) => cb(e.payload)),
    onConfirmQuit: async (cb) => listen<number>("confirm-quit", (e) => cb(e.payload)),
    setWindowTitle: async (title) => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTitle(title);
    },
    subscribeFrames: async (cb) => {
      const channel = new Channel<unknown>((msg) => cb(toBytes(msg)));
      await invoke("subscribe_frames", { channel });
    },
    // Raw bytes as the request body; the rest as headers.
    savePaste: (host, bytes, ext) => invoke("save_paste", bytes, { headers: { "chm-host": host, "chm-ext": ext } }),
  };
}

/** The phone's web app, served by the Consuls server (built with vite.web.config.ts). */
export const inWebApp = !inTauri && import.meta.env.VITE_CONSULS_WEB === "1";

let backendPromise: Promise<Backend> | null = null;

export function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = inTauri
      ? tauriBackend()
      : inWebApp
        ? import("./webBackend").then((m) => m.webBackend())
        : import("./mock").then((m) => m.mockBackend());
  }
  return backendPromise;
}
