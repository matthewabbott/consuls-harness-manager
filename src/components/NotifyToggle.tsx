// "Push to phone": a tracked agent pushes to your phone (through the push daemon) when it's
// still waiting for you after a while. Kept on the tmux pane (`@chm_notify`), so every device
// agrees, and one click away on the tile itself. Off by default.

import { Smartphone } from "lucide-react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";

/** tmux panes running an agent (or already tracked): the daemon can't see plain shells. */
export function canTrack(p: PaneInfo): boolean {
  return p.kind === "tmux" && (p.notify !== null || (p.harness !== null && p.harness !== "shell"));
}

export function toggleNotify(p: PaneInfo) {
  void backend().then((b) => b.setPaneNotify(p.key, p.notify ? null : "delay"));
}

export function notifyTitle(p: PaneInfo): string {
  return p.notify
    ? "Pushing to your phone when it's still waiting for you after a few minutes (click to stop)"
    : "Push to your phone when it's still waiting for you after a few minutes";
}

export default function NotifyToggle({ pane, small = false }: { pane: PaneInfo; small?: boolean }) {
  const on = pane.notify !== null;
  return (
    <button
      type="button"
      aria-pressed={on}
      title={notifyTitle(pane)}
      // The tile expands on click and starts a drag on pointerdown.
      onClick={(e) => {
        e.stopPropagation();
        toggleNotify(pane);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`shrink-0 rounded-md p-1 transition-colors ${
        on ? "bg-jade-400/10 text-jade-400 hover:bg-jade-400/20" : "text-mist-500/60 hover:bg-ink-600 hover:text-mist-200"
      }`}
    >
      <Smartphone className={small ? "h-3 w-3" : "h-3.5 w-3.5"} />
    </button>
  );
}
