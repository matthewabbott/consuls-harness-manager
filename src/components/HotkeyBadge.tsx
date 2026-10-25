import { assignLabel, jumpLabel } from "../lib/hotkeys";
import type { Target } from "../lib/layoutTree";
import { digitOf, useHotkeys } from "../store/hotkeys";

/** The hotkey that jumps to `target`, if it has one. */
export default function HotkeyBadge({ target, className = "" }: { target: Target; className?: string }) {
  const digit = useHotkeys((s) => digitOf(s.keys, target));
  if (digit === null) return null;
  return (
    <span
      title={`${jumpLabel(digit)} jumps here (${assignLabel(digit)} on something else moves it)`}
      className={`shrink-0 rounded bg-ink-700/80 px-1 py-px font-mono text-[10px] leading-none text-mist-300 ring-1 ring-ink-600 ${className}`}
    >
      {jumpLabel(digit)}
    </span>
  );
}
