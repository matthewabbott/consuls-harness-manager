// Unsaved editor buffers, kept in IndexedDB so they survive quitting the app ("hot exit").

import type { FileStamp } from "../ipc/bindings/FileStamp";

export interface Draft {
  id: string;
  host: string;
  path: string;
  /** The buffer, with the file's own line endings. */
  text: string;
  eol: "lf" | "crlf";
  bom: boolean;
  /** The file as it was when the buffer was loaded (to spot outside changes on restore). */
  stamp: FileStamp | null;
  origin: number | null;
  savedAt: number;
}

const DB = "consuls";
const STORE = "drafts";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const drafts = {
  put: (d: Draft) => tx("readwrite", (s) => s.put(d)).catch(() => undefined),
  remove: (id: string) => tx("readwrite", (s) => s.delete(id)).catch(() => undefined),
  all: () => tx<Draft[]>("readonly", (s) => s.getAll() as IDBRequest<Draft[]>).catch(() => [] as Draft[]),
};
