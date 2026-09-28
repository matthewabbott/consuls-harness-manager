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

/** One-click keys for menus and prompts the composer can't drive (permission choices etc.). */
export default function QuickKeys({ paneKey, harness }: { paneKey: number; harness: Harness | null }) {
  const keys = [...COMMON, ...((harness && PER_HARNESS[harness]) || [])];
  const send = (k: Key) => backend().then((b) => b.sendKeys(paneKey, k.keys));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {keys.map((k) => (
        <button
          key={k.label}
          title={k.title}
          onMouseDown={(e) => e.preventDefault()} // keep focus where it is
          onClick={() => send(k)}
          className="min-w-7 rounded-md bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-mist-300 ring-1 ring-ink-700 transition-colors hover:bg-ink-700 hover:text-mist-100"
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
