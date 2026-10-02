// A folder being browsed on the phone (the file browser, the new-session and folder pickers):
// its listing, and back/forward through where you've been, like the desktop's browsers.

import { useCallback, useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { DirListing } from "../ipc/bindings/DirListing";
import { canBack, canForward, emptyHistory, type History, pushHistory, replaceCurrent, stepHistory } from "../lib/history";
import { sameFolder } from "../lib/paths";

export interface Folder {
  listing: DirListing | null;
  /** The folder shown (as the machine names it: `~` comes back as the home folder). */
  path: string | null;
  loading: boolean;
  error: string | null;
  /** Goes to a folder; back returns here. A folder that can't be listed leaves you where you were. */
  go(path: string): void;
  reload(): void;
  back(): void;
  forward(): void;
  canBack: boolean;
  canForward: boolean;
}

export function useFolder(host: string, start: string | null): Folder {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [history, setHistory] = useState<History<string>>(emptyHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const historyRef = useRef(history);
  historyRef.current = history;

  /** `visit`: a new place (pushed); otherwise history has already moved there. */
  const load = useCallback(
    async (path: string, visit: boolean) => {
      const id = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const l = await (await backend()).listDir(host, path);
        if (id !== request.current) return;
        setListing(l);
        // History keeps the name the machine gave it (`~` → `/home/u`).
        setHistory((h) => (visit ? pushHistory(h, l.path, sameFolder) : replaceCurrent(h, l.path)));
      } catch (e) {
        if (id === request.current) setError(String(e));
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    setListing(null);
    setHistory(emptyHistory());
    if (start !== null) void load(start, true);
  }, [host, start, load]);

  const step = (delta: -1 | 1) => {
    const moved = stepHistory(historyRef.current, delta);
    if (!moved) return;
    setHistory(moved.history);
    void load(moved.entry, false);
  };

  return {
    listing,
    path: listing?.path ?? null,
    loading,
    error,
    go: (path) => void load(path, true),
    reload: () => listing && void load(listing.path, false),
    back: () => step(-1),
    forward: () => step(1),
    canBack: canBack(history),
    canForward: canForward(history),
  };
}
