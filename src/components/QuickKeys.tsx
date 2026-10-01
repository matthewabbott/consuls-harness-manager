import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { Harness } from "../ipc/bindings/Harness";

interface Key {
  label: string;
  keys: string[];
  title: string;
}

const COMMON: Key[] = [
  { label: "Esc", keys: ["Escape"], title: "Escape — interrupt the agent / dismiss" },
  { label: "^C", keys: ["C-c"], title: "Ctrl+C" },
  { label: "↑", keys: ["Up"], title: "Up" },
  { label: "↓", keys: ["Down"], title: "Down" },
  { label: "⏎", keys: ["Enter"], title: "Enter" },
  { label: "Tab", keys: ["Tab"], title: "Tab" },
  { label: "1", keys: ["1"], title: "Pick option 1" },
  { label: "2", keys: ["2"], title: "Pick option 2" },
  { label: "3", keys: ["3"], title: "Pick option 3" },
];

const PER_HARNESS: Partial<Record<Harness, Key[]>> = {
  claude: [
    { label: "⇧Tab", keys: ["BTab"], title: "Shift+Tab — cycle permission mode" },
    { label: "^O", keys: ["C-o"], title: "Ctrl+O — expand/collapse details" },
  ],
  codex: [{ label: "^T", keys: ["C-t"], title: "Ctrl+T — transcript" }],
  omp: [{ label: "⇧Tab", keys: ["BTab"], title: "Shift+Tab — cycle mode" }],
};

/** Keys that end things: on a phone they take a second tap (two ^C quit Claude Code). */
const CONFIRM = new Set(["^C"]);

/**
 * One-click keys for menus and prompts the composer can't drive (permission choices etc.).
 * `touch`: finger-sized, in one row that scrolls sideways (the phone).
 */
export default function QuickKeys({ paneKey, harness, touch = false }: { paneKey: number; harness: Harness | null; touch?: boolean }) {
  const keys = [...COMMON, ...((harness && PER_HARNESS[harness]) || [])];
  const [armed, setArmed] = useState<string | null>(null);
  const disarm = useRef(0);
  useEffect(() => () => window.clearTimeout(disarm.current), []);
  const send = (k: Key) => {
    window.clearTimeout(disarm.current);
    if (touch && CONFIRM.has(k.label) && armed !== k.label) {
      setArmed(k.label);
      disarm.current = window.setTimeout(() => setArmed(null), 2500);
      return;
    }
    setArmed(null);
    void backend().then((b) => b.sendKeys(paneKey, k.keys));
  };
  return (
    <div className={touch ? "no-scrollbar flex items-center gap-1.5 overflow-x-auto" : "flex flex-wrap items-center gap-1"}>
      {keys.map((k) => (
        <button
          key={k.label}
          title={k.title}
          onMouseDown={(e) => e.preventDefault()} // keep focus where it is
          onClick={() => send(k)}
          className={
            touch
              ? `min-w-10 shrink-0 rounded-lg px-2.5 py-2 font-mono text-[14px] ring-1 active:bg-ink-600 ${
                  armed === k.label ? "bg-rose-400/15 text-rose-300 ring-rose-400/50" : "bg-ink-800 text-mist-200 ring-ink-700"
                }`
              : "min-w-7 rounded-md bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-mist-300 ring-1 ring-ink-700 transition-colors hover:bg-ink-700 hover:text-mist-100"
          }
        >
          {armed === k.label ? `${k.label} again` : k.label}
        </button>
      ))}
    </div>
  );
}
