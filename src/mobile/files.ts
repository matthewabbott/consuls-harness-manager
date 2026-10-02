// The phone's file browser: where it's open (the machine list, a pane's menu and tapped paths
// open it), and the transfers under way, which carry on when it's closed.

import { create } from "zustand";

import { backend } from "../ipc/backend";
import { baseName, parentPath } from "../lib/paths";

export interface FilesAt {
  host: string;
  dir: string;
  /** A file to show at once (a tapped path), at a line. */
  file?: { path: string; line?: number };
}

export const useFilesScreen = create<{ at: FilesAt | null; open(at: FilesAt): void; close(): void }>((set) => ({
  at: null,
  open: (at) => set({ at }),
  close: () => set({ at: null }),
}));

/** Opens a path: a folder in the browser, a file in the viewer (beside its folder). */
export async function openPath(host: string, path: string, line?: number) {
  try {
    const listing = await (await backend()).listDir(host, path);
    useFilesScreen.getState().open({ host, dir: listing.path });
  } catch {
    useFilesScreen.getState().open({ host, dir: parentPath(path), file: { path, line } });
  }
}

export interface Transfer {
  id: number;
  kind: "upload" | "download";
  host: string;
  /** The folder an upload goes into; the file a download comes from. */
  path: string;
  name: string;
  total: number;
  done: number;
  state: "queued" | "running" | "ready" | "failed";
  error?: string;
  /** A download, fetched and ready to save (share sheet), or its link when too big to hold. */
  file?: File;
  url?: string;
  /** What an upload sends (kept for a retry). */
  source?: File;
  abort?: AbortController;
}

interface Transfers {
  list: Transfer[];
  update(id: number, patch: Partial<Transfer>): void;
  remove(id: number): void;
}

export const useTransfers = create<Transfers>((set) => ({
  list: [],
  update: (id, patch) => set((s) => ({ list: s.list.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  remove: (id) => set((s) => ({ list: s.list.filter((t) => t.id !== id) })),
}));

let nextId = 1;
/** Folders an upload landed in (the browser reloads the one it shows). */
const landed = new Set<(host: string, dir: string) => void>();
export function onUploaded(cb: (host: string, dir: string) => void): () => void {
  landed.add(cb);
  return () => landed.delete(cb);
}

/** One upload at a time: they share the phone's connection (and the machine's). */
let uploading = false;

async function pump() {
  if (uploading) return;
  const next = useTransfers.getState().list.find((t) => t.kind === "upload" && t.state === "queued");
  if (!next || !next.source) return;
  uploading = true;
  const { update } = useTransfers.getState();
  const abort = new AbortController();
  update(next.id, { state: "running", abort, done: 0 });
  try {
    const path = await (await backend()).uploadFile(next.host, next.path, next.source, (done) => update(next.id, { done }), abort.signal);
    update(next.id, { state: "ready", done: next.total, name: baseName(path), source: undefined });
    landed.forEach((cb) => cb(next.host, next.path));
    // Done ones go after a moment.
    setTimeout(() => useTransfers.getState().remove(next.id), 4000);
  } catch (e) {
    update(next.id, { state: "failed", error: String(e) });
  } finally {
    uploading = false;
    void pump();
  }
}

export function upload(host: string, dir: string, files: File[]) {
  const added: Transfer[] = files.map((f) => ({ id: nextId++, kind: "upload", host, path: dir, name: f.name, total: f.size, done: 0, state: "queued", source: f }));
  useTransfers.setState((s) => ({ list: [...s.list, ...added] }));
  void pump();
}

export function retry(id: number) {
  useTransfers.getState().update(id, { state: "queued", error: undefined });
  void pump();
}

export function cancel(t: Transfer) {
  if (t.state === "running") t.abort?.abort();
  useTransfers.getState().remove(t.id);
}

/** Files bigger than this aren't held in memory to share: the share sheet gets a link instead. */
const HOLD_LIMIT = 250 * 1024 * 1024;

/**
 * Fetches a file to save from the phone. Saving is a second tap ("Save…"): iOS opens the share
 * sheet only within a tap, and a fetch can take longer than a tap lasts.
 */
export async function download(host: string, path: string, size: number) {
  const id = nextId++;
  const name = baseName(path);
  const abort = new AbortController();
  useTransfers.setState((s) => ({ list: [...s.list, { id, kind: "download", host, path, name, total: size, done: 0, state: "running", abort }] }));
  const { update } = useTransfers.getState();
  try {
    const url = await (await backend()).fileUrl(host, path);
    if (size > HOLD_LIMIT || typeof navigator.canShare !== "function") {
      update(id, { state: "ready", url, done: size });
      return;
    }
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok || !res.body) throw (await res.text()) || res.statusText;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value);
      done += value.length;
      update(id, { done });
    }
    const type = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    update(id, { state: "ready", file: new File(chunks as BlobPart[], name, { type }), url });
  } catch (e) {
    if (!abort.signal.aborted) update(id, { state: "failed", error: String(e) });
  }
}

/** The second tap: the share sheet (Save to Files or Photos, AirDrop, …), else the link itself. */
export function save(t: Transfer) {
  if (t.file && navigator.canShare?.({ files: [t.file] })) {
    navigator.share({ files: [t.file] }).then(
      () => useTransfers.getState().remove(t.id),
      () => {}, // dismissed: keep it for another try
    );
    return;
  }
  const a = document.createElement("a");
  a.href = t.file ? URL.createObjectURL(t.file) : (t.url ?? "");
  a.download = t.name;
  a.rel = "noopener";
  a.click();
}
