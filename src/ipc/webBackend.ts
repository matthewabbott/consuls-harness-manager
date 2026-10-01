// The phone's web app talks to the Consuls server (crates/chm-daemon) over one WebSocket:
// calls go out as `{id, method, params}` (the same commands as the desktop app's), replies,
// core events and pane frames come back (crates/chm-daemon/src/ws.rs).
//
// iOS suspends a Home Screen app as soon as it's hidden, so the socket dies often: it reconnects
// by itself (at once when the app comes back on screen), then re-sends what the server needs to
// carry on — the frame subscription, the open panes' streams, what's on screen — and the app
// fetches a fresh snapshot (`connection.epoch`). A server that restarted has new pane keys: the
// page reloads.

import { create } from "zustand";

import { type Backend, type Call, commands } from "./backend";
import type { CoreEvent } from "./bindings/CoreEvent";

type State = "connecting" | "open" | "offline" | "takenOver";

interface Connection {
  state: State;
  /** The server's machine (its panes are `@local`). */
  selfName: string | null;
  /** Counts hellos: the app re-reads the snapshot when it goes up after the first. */
  epoch: number;
  /** Connect again now (after "in use on another device", or from the offline screen). */
  retry(): void;
}

export const useConnection = create<Connection>(() => ({ state: "connecting", selfName: null, epoch: 0, retry: () => conn.retry() }));

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

class Conn {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Calls made while there's no socket: sent once there is one. */
  private queued: string[] = [];
  private instance: string | null = null;
  private backoff = 1000;
  private timer = 0;
  private events = new Set<(ev: CoreEvent) => void>();
  private frames: ((bytes: Uint8Array) => void) | null = null;
  // What the server must be told again after a reconnect.
  private streams = new Set<number>();
  private focus: unknown = null;
  private visible: unknown = undefined;

  constructor() {
    this.connect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.check();
    });
  }

  private connect() {
    window.clearTimeout(this.timer);
    if (useConnection.getState().state !== "offline") useConnection.setState({ state: "connecting" });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => this.message(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject("the connection to the server dropped");
      this.pending.clear();
      if (useConnection.getState().state === "takenOver") return;
      useConnection.setState({ state: "offline" });
      this.timer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
  }

  private message(data: unknown) {
    if (data instanceof ArrayBuffer) {
      this.frames?.(new Uint8Array(data));
      return;
    }
    const msg = JSON.parse(String(data));
    switch (msg.type) {
      case "hello":
        if (this.instance && this.instance !== msg.instance) {
          // The server started again: its pane keys mean other panes now.
          location.reload();
          return;
        }
        this.instance = msg.instance;
        this.backoff = 1000;
        this.replay();
        useConnection.setState((s) => ({ state: "open", selfName: msg.selfName, epoch: s.epoch + 1 }));
        break;
      case "reply": {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if ("error" in msg) p?.reject(msg.error);
        else p?.resolve(msg.ok);
        break;
      }
      case "event":
        for (const cb of this.events) cb(msg.event);
        break;
      case "resync":
        // Events were missed: the app re-reads everything.
        useConnection.setState((s) => ({ epoch: s.epoch + 1 }));
        break;
      case "takenOver":
        useConnection.setState({ state: "takenOver" });
        this.ws?.close();
        break;
    }
  }

  /** Tells a new socket what the last one had going, then sends what queued up meanwhile. */
  private replay() {
    const send = (method: string, params: unknown) => this.ws?.send(JSON.stringify({ id: this.nextId++, method, params }));
    if (this.frames) send("subscribe_frames", {});
    if (this.visible !== undefined) send("set_visible_panes", this.visible);
    for (const key of this.streams) send("stream_pane", { key, on: true });
    if (this.focus) send("set_focus", this.focus);
    for (const text of this.queued.splice(0)) this.ws?.send(text);
  }

  /** Back on screen: a socket iOS froze may look open and be dead, so it has to answer. */
  private async check() {
    if (useConnection.getState().state === "takenOver") return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return this.retry();
    const alive = await Promise.race([this.call("ping").then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    if (!alive) this.retry();
  }

  retry() {
    this.backoff = 1000;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  call: Call = (method, args = {}) => {
    if (method === "stream_pane") {
      if (args.on) this.streams.add(args.key as number);
      else this.streams.delete(args.key as number);
    } else if (method === "set_focus") {
      this.focus = args;
    } else if (method === "set_visible_panes") {
      this.visible = args;
    }
    const id = this.nextId++;
    const text = JSON.stringify({ id, method, params: args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (this.ws?.readyState === WebSocket.OPEN && useConnection.getState().state === "open") this.ws.send(text);
      else this.queued.push(text);
    });
  };

  onEvent(cb: (ev: CoreEvent) => void): () => void {
    this.events.add(cb);
    return () => this.events.delete(cb);
  }

  onFrames(cb: (bytes: Uint8Array) => void) {
    this.frames = cb;
  }
}

const conn = new Conn();

const notHere = (what: string) => () => Promise.reject(`${what} isn't available in the web app`);

/** Opens an https link from a tap (iOS blocks window.open after an await). */
function openLink(url: string): Promise<void> {
  if (!url.startsWith("https://") || /[\s\p{Cc}]/u.test(url)) return Promise.reject(`refusing to open ${url}`);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
  return Promise.resolve();
}

export async function webBackend(): Promise<Backend> {
  return {
    kind: "web",
    ...commands(conn.call),
    onEvent: async (cb) => conn.onEvent(cb),
    onAlert: async () => () => {},
    onFocusPane: async () => () => {},
    onConfirmQuit: async () => () => {},
    quitApp: async () => {},
    localDrives: async () => [],
    testChime: async () => {},
    setWindowTitle: async (title) => {
      document.title = title;
    },
    openExternal: openLink,
    revealPath: notHere("Showing files on this device"),
    vscodeStatus: async () => ({ installed: false, remoteSsh: false }),
    openInVscode: notHere("VS Code"),
    readBytes: notHere("Image previews"),
    subscribeFrames: async (cb) => {
      conn.onFrames(cb);
      await conn.call("subscribe_frames");
    },
    savePaste: async (host, bytes, ext) => {
      const res = await fetch(`/api/paste?host=${encodeURIComponent(host)}&ext=${encodeURIComponent(ext)}`, {
        method: "POST",
        headers: { "X-Consuls": "1", "Content-Type": "application/octet-stream" },
        body: bytes as BodyInit,
      });
      if (!res.ok) throw (await res.text()) || res.statusText;
      return res.json();
    },
  };
}
