// Decides when to resize the expanded pane's tmux window.
//
// Resizes are expensive on the far end (Claude Code redraws its whole transcript, and we re-seed
// thousands of lines), so we only send one when the *local* layout has settled or the user chose
// a size — never because the remote size changed, and never twice for the same target.

import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { paneIdentity } from "../lib/panes";
import { useSettledSize } from "../lib/useSettledSize";
import { useApp } from "../store/app";
import { useUi } from "../store/ui";
import { FONT, useViewPrefs, type SizeMode } from "../store/viewPrefs";

export interface CellSize {
  width: number;
  height: number;
}

/** Padding inside the terminal frame (Tailwind p-3 on each side). */
export const FRAME_PADDING = 24;

export function cellsFor(px: { width: number; height: number }, cell: CellSize): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.floor((px.width - FRAME_PADDING) / cell.width)),
    rows: Math.max(5, Math.floor((px.height - FRAME_PADDING) / cell.height)),
  };
}

export interface Sizing {
  mode: SizeMode;
  /** Effective mode (Maximize forces fit). */
  effective: SizeMode;
  /** Font size to render with; `null` = fit the text to the pane width (scale mode). */
  fontSize: number | null;
  /** The pane was resized by something other than us since our last request. */
  resizedElsewhere: boolean;
  refit(): void;
  setMode(mode: SizeMode, size?: { cols: number; rows: number }): void;
  release(): void;
}

export function useTerminalSizing(
  pane: PaneInfo,
  frameRef: React.RefObject<HTMLElement | null>,
  cellSize: () => CellSize | null,
): Sizing {
  const id = paneIdentity(pane);
  const pref = useViewPrefs((s) => s.prefs[id]);
  const maximized = useUi((s) => s.maximized);
  const settled = useSettledSize(frameRef);
  const split = (pane.tmux?.windowPanes ?? 1) > 1;
  const mode: SizeMode = pref?.sizeMode ?? (split ? "scale" : "fit");
  // An ended direct pane has nothing left to resize: just show what it had.
  const effective: SizeMode = pane.ended ? "scale" : maximized ? "fit" : mode;
  const fontSize = effective === "scale" ? (pref?.fontSize ?? null) : (pref?.fontSize ?? FONT.default);
  const lastRequest = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [resizedElsewhere, setResizedElsewhere] = useState(false);

  // The first expand decides the mode, so later expands "remember" it.
  useEffect(() => {
    if (!pref?.sizeMode) useViewPrefs.getState().setSizeMode(id, split ? "scale" : "fit");
  }, [id, pref?.sizeMode, split]);

  // Send a resize when the layout settles, the mode/size/font changes, or the user asks (nonce).
  useEffect(() => {
    if (!settled || effective === "scale") return;
    let target: { cols: number; rows: number } | null = null;
    if (effective === "fit") {
      // Wait a frame so a font change has been applied before measuring cells.
      const cell = cellSize();
      if (!cell) return;
      target = cellsFor(settled, cell);
    } else if (pref?.cols && pref?.rows) {
      target = { cols: pref.cols, rows: pref.rows };
    }
    if (!target) return;
    const current = useApp.getState().panes[pane.host]?.find((p) => p.key === pane.key);
    if (current && current.width === target.cols && current.height === target.rows) return;
    const last = lastRequest.current;
    if (last && last.cols === target.cols && last.rows === target.rows && Date.now() - last.at < 3000) return;
    lastRequest.current = { ...target, at: Date.now() };
    setResizedElsewhere(false);
    backend()
      .then((b) => b.resizePane(pane.key, target.cols, target.rows))
      .then((outcome) => {
        if (outcome.otherClients > 0 && !useViewPrefs.getState().prefs[id]?.warnedOthers) {
          useViewPrefs.getState().update(id, { warnedOthers: true });
          useApp
            .getState()
            .notify(
              "info",
              `This session is also open on ${outcome.otherClients} other device${outcome.otherClients === 1 ? "" : "s"}. While Harness Manager sets the window size, their view is cropped or padded — choose “Don't resize” or “Let tmux decide” in the size menu to hand it back.`,
              pane.host,
            );
        }
      })
      .catch((e) => useApp.getState().notify("warning", `Couldn't resize: ${e}`, pane.host));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, effective, pref?.cols, pref?.rows, fontSize, nonce, pane.key]);

  // Someone else changed the size after we set it: say so rather than fighting.
  useEffect(() => {
    const last = lastRequest.current;
    if (!last || effective === "scale") return;
    if (Date.now() - last.at < 3000) return;
    setResizedElsewhere(pane.width !== last.cols || pane.height !== last.rows);
  }, [pane.width, pane.height, effective]);

  return {
    mode,
    effective,
    fontSize,
    resizedElsewhere,
    refit: () => {
      lastRequest.current = null;
      setResizedElsewhere(false);
      setNonce((n) => n + 1);
    },
    setMode: (m, size) => {
      lastRequest.current = null;
      useViewPrefs.getState().setSizeMode(id, m, size);
      setNonce((n) => n + 1);
    },
    release: () => {
      lastRequest.current = null;
      useViewPrefs.getState().setSizeMode(id, "scale");
      backend().then((b) => b.releasePaneSize(pane.key));
    },
  };
}
