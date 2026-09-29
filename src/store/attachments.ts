// Images pasted into a pane's composer. Each is saved on the pane's machine as soon as it's
// pasted (agents read it from there) and sent with the next prompt. Kept per pane for the
// session, so switching panes doesn't lose them.

import { create } from "zustand";

import { backend } from "../ipc/backend";
import { useApp } from "./app";

export interface Attachment {
  id: number;
  /** Object URL, for the thumbnail. */
  url: string;
  size: number;
  /** Where it was saved on the pane's machine; null while saving (or if that failed). */
  path: string | null;
  error: string | null;
  /** Settles with the path, or null if saving failed. */
  saved: Promise<string | null>;
}

interface AttachmentsState {
  byPane: Record<string, Attachment[]>;
}

export const useAttachments = create<AttachmentsState>(() => ({ byPane: {} }));

const NONE: Attachment[] = [];
export const useAttachmentsOf = (paneId: string) => useAttachments((s) => s.byPane[paneId] ?? NONE);
export const attachmentsOf = (paneId: string) => useAttachments.getState().byPane[paneId] ?? NONE;

function update(paneId: string, fn: (list: Attachment[]) => Attachment[]) {
  useAttachments.setState((s) => ({ byPane: { ...s.byPane, [paneId]: fn(s.byPane[paneId] ?? NONE) } }));
}

/** Types agents accept as they are; anything else the browser can decode is sent as PNG. */
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** The image files in a clipboard or drop, if any. Text wins (copying from a document can
 *  bring a picture of the selection along). */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data || data.getData("text/plain")) return [];
  const files = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) return files;
  // Some sources only expose items.
  return [...data.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).flatMap((i) => i.getAsFile() ?? []);
}

async function encoded(file: Blob): Promise<{ bytes: Uint8Array; ext: string }> {
  const ext = EXT[file.type];
  if (ext) return { bytes: new Uint8Array(await file.arrayBuffer()), ext };
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return { bytes: new Uint8Array(await png.arrayBuffer()), ext: "png" };
}

let nextId = 1;

/** Saves `blob` on `host` and returns the path (for pasting straight into a terminal). */
export async function savePastedImage(host: string, blob: Blob): Promise<string> {
  const { bytes, ext } = await encoded(blob);
  return backend().then((b) => b.savePaste(host, bytes, ext));
}

/** A path pasted on its own, as agents recognise one (see `harness::pasted_path` in the core):
 *  Windows paths as they are, others shell-quoted when they hold spaces or quotes. */
export function pastedPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || !/[\s'"]/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Images pasted into the terminal itself: each is saved on the pane's machine and its path
 *  pasted on its own (Claude Code and Codex turn such a paste into an attachment). */
export async function pasteImagesInto(key: number, host: string, files: Blob[]) {
  const b = await backend();
  for (const file of files) {
    try {
      await b.pasteText(key, pastedPath(await savePastedImage(host, file)));
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      useApp.getState().notify("warning", `Couldn't save the image on the machine: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
}

/** Adds pasted images to a pane's composer and starts saving them on `host`. */
export function attachImages(paneId: string, host: string, files: Blob[]) {
  for (const file of files) {
    const id = nextId++;
    const patch = (p: Partial<Attachment>) => update(paneId, (list) => list.map((a) => (a.id === id ? { ...a, ...p } : a)));
    const saved = savePastedImage(host, file).then(
      (path) => {
        patch({ path });
        return path;
      },
      (e: unknown) => {
        patch({ error: e instanceof Error ? e.message : String(e) });
        return null;
      },
    );
    update(paneId, (list) => [...list, { id, url: URL.createObjectURL(file), size: file.size, path: null, error: null, saved }]);
  }
}

export function removeAttachment(paneId: string, id: number) {
  const a = attachmentsOf(paneId).find((a) => a.id === id);
  if (a) URL.revokeObjectURL(a.url);
  update(paneId, (list) => list.filter((a) => a.id !== id));
}

/** Takes the pane's attachments for sending: resolves to the saved paths and how many failed. */
export async function takeAttachments(paneId: string): Promise<{ paths: string[]; failed: number }> {
  const list = attachmentsOf(paneId);
  update(paneId, () => NONE);
  const results = await Promise.all(list.map((a) => a.saved));
  for (const a of list) URL.revokeObjectURL(a.url);
  const paths = results.filter((p): p is string => p !== null);
  return { paths, failed: results.length - paths.length };
}
