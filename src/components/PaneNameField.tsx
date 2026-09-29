import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { useRecording } from "../store/recording";
import { displayTitle } from "./MiniTile";

/** Where a pane's name is kept, for the hint under the field. */
export function renameHint(p: PaneInfo): string {
  return p.tmux ? "Shown in Consuls (on every device); tmux keeps its own names." : "Kept while the shell runs.";
}

/**
 * Inline editor for a pane's name, starting from what the pane shows now. Enter saves (an
 * empty field clears the name), Escape cancels, and leaving the field saves when `saveOnBlur`.
 */
export default function PaneNameField({
  pane,
  onDone,
  className,
  saveOnBlur = false,
}: {
  pane: PaneInfo;
  onDone(): void;
  className?: string;
  saveOnBlur?: boolean;
}) {
  const [initial] = useState(() => displayTitle(pane));
  // Recording mode: don't put a title with personal details in an editable field.
  const [start] = useState(() => (useRecording.getState().ui(initial) === initial ? initial : ""));
  const [value, setValue] = useState(start);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.replace(/\s+/g, " ").trim();
    // Leaving the field as it was doesn't freeze the shown title into a name.
    if (save && value !== start && name !== (pane.name ?? "")) {
      backend().then((b) => b.renamePane(pane.key, name || null));
    }
    onDone();
  };

  return (
    <input
      ref={ref}
      value={value}
      maxLength={60}
      spellCheck={false}
      aria-label="Pane name"
      placeholder="Automatic name"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => saveOnBlur && finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`rounded-md bg-ink-900 px-2 py-1 text-mist-100 ring-1 ring-sky-400/60 outline-none placeholder:text-mist-600 ${className ?? ""}`}
    />
  );
}
