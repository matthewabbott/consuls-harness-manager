// When a tracked agent pushes to the phone (`@chm_notify` on its tmux pane, shared by every
// device): the choices, worded once for the desktop's tile menu and the phone's pane menu.

import { backend } from "../ipc/backend";
import type { NotifyMode } from "../ipc/bindings/NotifyMode";

export const NOTIFY_MODES: { mode: NotifyMode | null; label: string; hint: string }[] = [
  { mode: null, label: "Off", hint: "No pushes for this agent" },
  { mode: "delay", label: "After a delay", hint: "If it's still waiting for you then" },
  { mode: "any", label: "Any turn end", hint: "Right away, questions included" },
  { mode: "finished", label: "Finished turns only", hint: "Right away; not questions or prompts" },
];

export function setNotifyMode(key: number, mode: NotifyMode | null) {
  void backend().then((b) => b.setPaneNotify(key, mode));
}

/** `pausedUntil` this far ahead means "until turned back on". */
export const UNTIL_RESUMED = 253_402_300_799; // 9999-12-31

export function pausedText(until: number | null, now = Date.now() / 1000): string | null {
  if (until === null || until <= now) return null;
  if (until >= UNTIL_RESUMED) return "Paused until you turn them back on";
  const at = new Date(until * 1000);
  const sameDay = at.toDateString() === new Date(now * 1000).toDateString();
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Paused until ${sameDay ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`}`;
}
