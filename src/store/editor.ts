// Open files: what's loaded, what's unsaved, and what changed on disk meanwhile. The live
// buffers are CodeMirror states kept outside React (see `buffers`), so switching files keeps
// each one's undo history and cursor.

import type { EditorState, Text } from "@codemirror/state";
import { create } from "zustand";

import { backend } from "../ipc/backend";
import type { FileStamp } from "../ipc/bindings/FileStamp";
import type { SaveError } from "../ipc/bindings/SaveError";
import { drafts } from "../lib/drafts";

export type Eol = "lf" | "crlf";

export interface OpenFile {
  id: string;
  host: string;
  path: string;
  name: string;
  /** Pane it was opened from (its tile sits next to that pane's). */
  origin: number | null;
  kind: "loading" | "text" | "image" | "binary" | "tooLarge" | "error";
  error?: string;
  size?: number;
  eol: Eol;
  bom: boolean;
  /** The file on disk as last read or written. */
  stamp: FileStamp | null;
  dirty: boolean;
  saving: boolean;
  /** Set when the file changed (or was deleted: null) on disk while the buffer was dirty. */
  conflict?: FileStamp | null;
  /** First lines, for the grid tile. */
  preview: string;
  /** Came back from an unsaved buffer after a restart. */
  restored?: boolean;
  /** Bumped whenever the buffer is replaced from disk (the editor then starts afresh). */
  gen: number;
}

interface Buffer {
  /** The file's text as on disk (normalized to \n), to tell dirty from clean. */
  saved: Text | null;
  /** The editor state while the file isn't on screen. */
  state: EditorState | null;
  /** Text to load into a fresh editor (with \n line breaks). */
  initial: string;
}

/** Live buffers, by file id. Not in React state: updated on every keystroke. */
export const buffers = new Map<string, Buffer>();

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

export const fileId = (host: string, path: string) => `${host}\n${path}`;

/** Most common line ending in `text`. */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "crlf" : "lf";
}

function previewOf(text: string): string {
  return text.split(/\r?\n/, 16).join("\n");
}

interface EditorStore {
  files: Record<string, OpenFile>;
  order: string[];
  active: string | null;

  open(host: string, path: string, origin?: number | null): Promise<void>;
  close(id: string): void;
  setActive(id: string | null): void;
  /** The editor reports its buffer changed. */
  edited(id: string, doc: Text): void;
  save(id: string, opts?: { force?: boolean }): Promise<boolean>;
  /** Replace the buffer with the file on disk (discarding unsaved changes). */
  reload(id: string): Promise<void>;
  setEol(id: string, eol: Eol): void;
  /** Checks open files for outside changes. */
  poll(ids?: string[]): Promise<void>;
  restoreDrafts(): Promise<void>;
}

let draftTimers: Record<string, number> = {};

function persistDraft(f: OpenFile) {
  window.clearTimeout(draftTimers[f.id]);
  draftTimers[f.id] = window.setTimeout(() => {
    const b = buffers.get(f.id);
    const doc = b?.state?.doc;
    if (!f.dirty || !doc) {
      void drafts.remove(f.id);
      return;
    }
    void drafts.put({
      id: f.id,
      host: f.host,
      path: f.path,
      text: doc.sliceString(0, doc.length, f.eol === "crlf" ? "\r\n" : "\n"),
      eol: f.eol,
      bom: f.bom,
      stamp: f.stamp,
      origin: f.origin,
      savedAt: Date.now(),
    });
  }, 400);
}

export const useEditor = create<EditorStore>((set, get) => {
  const patch = (id: string, p: Partial<OpenFile>) => set((s) => (s.files[id] ? { files: { ...s.files, [id]: { ...s.files[id], ...p } } } : {}));

  const load = async (id: string) => {
    const f = get().files[id];
    if (!f) return;
    const b = await backend();
    if (IMAGE.test(f.path)) {
      patch(id, { kind: "image" });
      return;
    }
    try {
      const content = await b.readFile(f.host, f.path);
      if (content.kind === "text") {
        const text = content.text;
        const { Text } = await import("@codemirror/state");
        const normalized = text.replace(/\r\n?/g, "\n");
        buffers.set(id, { saved: Text.of(normalized.split("\n")), state: null, initial: normalized });
        patch(id, {
          kind: "text",
          eol: detectEol(text),
          bom: content.bom,
          stamp: content.stamp,
          dirty: false,
          conflict: undefined,
          preview: previewOf(text),
          error: undefined,
          size: content.stamp.size,
          gen: (get().files[id]?.gen ?? 0) + 1,
        });
      } else {
        patch(id, { kind: content.kind, stamp: content.stamp, size: content.stamp.size });
      }
    } catch (e) {
      patch(id, { kind: "error", error: String(e) });
    }
  };

  return {
    files: {},
    order: [],
    active: null,

    open: async (host, path, origin = null) => {
      const id = fileId(host, path);
      if (get().files[id]) {
        set({ active: id });
        return;
      }
      const f: OpenFile = { id, host, path, name: path.split("/").pop() ?? path, origin, kind: "loading", eol: "lf", bom: false, stamp: null, dirty: false, saving: false, preview: "", gen: 0 };
      set((s) => ({ files: { ...s.files, [id]: f }, order: [...s.order, id], active: id }));
      await load(id);
    },

    close: (id) => {
      buffers.delete(id);
      void drafts.remove(id);
      set((s) => {
        const files = { ...s.files };
        delete files[id];
        return { files, order: s.order.filter((o) => o !== id), active: s.active === id ? null : s.active };
      });
    },

    setActive: (active) => set({ active }),

    edited: (id, doc) => {
      const b = buffers.get(id);
      const f = get().files[id];
      if (!b || !f) return;
      const dirty = !b.saved || !doc.eq(b.saved);
      if (dirty !== f.dirty) patch(id, { dirty });
      patch(id, { preview: doc.sliceString(0, Math.min(doc.length, 2000)).split("\n", 16).join("\n") });
      persistDraft({ ...f, dirty });
    },

    save: async (id, opts) => {
      const f = get().files[id];
      const b = buffers.get(id);
      const doc = b?.state?.doc;
      if (!f || !b || !doc || f.kind !== "text") return false;
      patch(id, { saving: true });
      const text = doc.sliceString(0, doc.length, f.eol === "crlf" ? "\r\n" : "\n");
      try {
        const stamp = await (await backend()).writeFile(f.host, f.path, text, f.bom, opts?.force ? null : f.stamp);
        b.saved = doc;
        patch(id, { stamp, dirty: false, saving: false, conflict: undefined, restored: false, size: stamp.size });
        void drafts.remove(id);
        return true;
      } catch (e) {
        const err = e as SaveError | string;
        if (typeof err === "object" && err.kind === "conflict") patch(id, { saving: false, conflict: err.current });
        else patch(id, { saving: false, error: typeof err === "object" ? err.message : String(err) });
        return false;
      }
    },

    reload: async (id) => {
      const b = buffers.get(id);
      if (b) b.state = null;
      patch(id, { kind: "loading", restored: false });
      await load(id);
      void drafts.remove(id);
    },

    setEol: (id, eol) => {
      patch(id, { eol });
      const f = get().files[id];
      const b = buffers.get(id);
      // Changing line endings is an edit: the file on disk differs now.
      if (f && b) {
        b.saved = null;
        patch(id, { dirty: true });
        persistDraft({ ...f, eol, dirty: true });
      }
    },

    poll: async (ids) => {
      const b = await backend();
      for (const id of ids ?? get().order) {
        const f = get().files[id];
        if (!f || f.kind !== "text" || f.saving || !f.stamp) continue;
        let cur: FileStamp | null;
        try {
          cur = await b.statFile(f.host, f.path);
        } catch {
          continue; // offline: try again later
        }
        const same = cur && cur.size === f.stamp.size && cur.mtime === f.stamp.mtime;
        if (same) continue;
        if (!f.dirty && cur) await get().reload(id);
        else if (f.conflict === undefined || JSON.stringify(f.conflict) !== JSON.stringify(cur)) patch(id, { conflict: cur });
      }
    },

    restoreDrafts: async () => {
      const list = await drafts.all();
      const { Text } = await import("@codemirror/state");
      for (const d of list) {
        if (get().files[d.id]) continue;
        const normalized = d.text.replace(/\r\n?/g, "\n");
        buffers.set(d.id, { saved: null, state: null, initial: normalized });
        const f: OpenFile = {
          id: d.id,
          host: d.host,
          path: d.path,
          name: d.path.split("/").pop() ?? d.path,
          origin: null,
          kind: "text",
          eol: d.eol,
          bom: d.bom,
          stamp: d.stamp,
          dirty: true,
          saving: false,
          preview: previewOf(d.text),
          restored: true,
          gen: 1,
        };
        set((s) => ({ files: { ...s.files, [d.id]: f }, order: [...s.order, d.id] }));
        // Learn what's on disk now, so saving checks against the right version.
        void backend()
          .then((b) => b.readFile(d.host, d.path))
          .then((c) => {
            if (c.kind !== "text") return;
            const onDisk = c.text.replace(/\r\n?/g, "\n");
            const buf = buffers.get(d.id);
            if (buf) buf.saved = Text.of(onDisk.split("\n"));
            const unchanged = d.stamp && c.stamp.size === d.stamp.size && c.stamp.mtime === d.stamp.mtime;
            patch(d.id, unchanged ? {} : { conflict: c.stamp });
          })
          .catch(() => undefined);
      }
    },
  };
});

/** Resets per-file draft timers (tests). */
export function _resetDraftTimers() {
  draftTimers = {};
}
