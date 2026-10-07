// The desktop's uploads and downloads (the shell streams them: src-tauri/src/transfers.rs), listed
// under the explorer. A finished upload refreshes the folder it went into.

import { create } from "zustand";

import { backend, type TransferEvent } from "../ipc/backend";
import { sameFolder } from "../lib/paths";
import { useApp } from "./app";
import { useFiles } from "./files";

export interface Transfer {
  id: number;
  upload: boolean;
  host: string;
  name: string;
  total: number;
  done: number;
  state: "queued" | "running" | "done" | "failed";
  error?: string;
  /** Where it landed: on the machine (upload) or this computer (download). */
  path?: string;
  /** The machine's folder an upload goes into. */
  dir?: string;
}

export const useTransfers = create<{ list: Transfer[] }>(() => ({ list: [] }));

const patch = (id: number, p: Partial<Transfer>) => useTransfers.setState((s) => ({ list: s.list.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

export function dismiss(id: number) {
  useTransfers.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

/** Reloads a folder the explorer shows, once uploads into it have settled for a moment. */
const reloads = new Map<string, number>();
function reloadSoon(host: string, dir: string) {
  const key = `${host}\n${dir}`;
  window.clearTimeout(reloads.get(key));
  reloads.set(
    key,
    window.setTimeout(() => {
      reloads.delete(key);
      const files = useFiles.getState();
      if (files.root?.host !== host) return;
      const shown = Object.keys(files.dirs).find((d) => sameFolder(d, dir));
      if (shown) void files.load(shown).then(() => files.refreshGit());
    }, 300),
  );
}

function apply(e: TransferEvent, host: string, dir?: string) {
  switch (e.kind) {
    case "queued":
      useTransfers.setState((s) => ({ list: [...s.list, { id: e.id, upload: e.upload, host, dir, name: e.name, total: e.total, done: 0, state: "queued" }] }));
      return;
    case "progress":
      patch(e.id, { done: e.done, state: "running" });
      return;
    case "failed":
      patch(e.id, { state: "failed", error: e.error });
      return;
    case "done": {
      const t = useTransfers.getState().list.find((x) => x.id === e.id);
      patch(e.id, { state: "done", done: t?.total ?? 0, path: e.path });
      if (t?.upload) {
        if (dir) reloadSoon(host, dir);
        window.setTimeout(() => dismiss(e.id), 5000);
      }
    }
  }
}

const fail = (e: unknown) => useApp.getState().notify("error", String(e));

/** Sends `paths` (or ones picked in a dialog: files, or folders) into `dir` on `host`. */
export async function uploadTo(host: string, dir: string, paths: string[] | null, folder = false) {
  try {
    await (await backend()).uploadPaths(host, dir, paths, folder, (e) => apply(e, host, dir));
  } catch (e) {
    fail(e);
  }
}

/** Asks where to save a file from `host`, then downloads it there. */
export async function downloadFrom(host: string, path: string) {
  try {
    await (await backend()).downloadTo(host, path, (e) => apply(e, host));
  } catch (e) {
    fail(e);
  }
}

export function cancel(t: Transfer) {
  if (t.state === "queued" || t.state === "running") void backend().then((b) => b.cancelTransfer(t.id));
  else dismiss(t.id);
}
