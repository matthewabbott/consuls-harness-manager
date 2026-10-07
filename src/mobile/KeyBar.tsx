// The phone's terminal keys (like Termius's): an agent's quick keys, Ctrl and Alt that stay held
// for the next key (tap once; tap again to lock, again to let go), and keys the iOS keyboard
// doesn't have.

import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isAgent } from "../components/HarnessBadge";
import { quickKeys } from "../components/QuickKeys";
import type { Harness } from "../ipc/bindings/Harness";
import { uiStorage } from "../lib/uiState";
import type { HeldMods } from "../term/softKeys";

export type Hold = "off" | "once" | "locked";

export interface Holds {
  ctrl: Hold;
  alt: Hold;
}

export const NO_HOLDS: Holds = { ctrl: "off", alt: "off" };

export const nextHold = (h: Hold): Hold => (h === "off" ? "once" : h === "once" ? "locked" : "off");

/** A one-shot hold lets go once used; a locked one stays. */
export const afterUse = (h: Hold): Hold => (h === "once" ? "off" : h);

export const heldMods = (holds: Holds): HeldMods => ({ ctrl: holds.ctrl !== "off", alt: holds.alt !== "off" });

type Key = { label: string; name: string; title?: string };

/** Beyond an agent's quick keys: what the iOS keyboard doesn't have. */
const EXTRA: Key[] = [
  { label: "←", name: "Left" },
  { label: "→", name: "Right" },
  { label: "PgUp", name: "PPage" },
  { label: "PgDn", name: "NPage" },
  { label: "Home", name: "Home" },
  { label: "End", name: "End" },
  { label: "|", name: "|" },
  { label: "~", name: "~" },
  { label: "/", name: "/" },
  { label: "-", name: "-" },
  { label: "`", name: "`" },
];

/** The row's keys, most used first: an agent's own keys for agents, Ctrl and arrows for shells. */
function keysFor(harness: Harness | null): (Key | "ctrl" | "alt")[] {
  const quick: Key[] = quickKeys(harness).map((k) => ({ label: k.label, name: k.keys[0], title: k.title }));
  const by = new Map([...quick, ...EXTRA].map((k) => [k.label, k]));
  const pick = (labels: string[]) => labels.flatMap((l) => (by.has(l) ? [by.get(l)!] : []));
  const symbols = pick(["PgUp", "PgDn", "Home", "End", "|", "~", "/", "-", "`"]);
  if (isAgent(harness)) return [...quick, "ctrl", "alt", ...pick(["←", "→"]), ...symbols];
  return ["ctrl", "alt", ...pick(["Esc", "Tab", "↑", "↓", "←", "→", "^C", "⏎"]), ...symbols];
}

/** Keys that end things take a second tap (two ^C quit Claude Code). */
const CONFIRM = new Set(["^C"]);

const KEY = "min-w-10 shrink-0 rounded-lg px-2.5 py-2 font-mono text-[14px] ring-1";

function ModKey({ label, hold, onClick }: { label: string; hold: Hold; onClick(): void }) {
  const tone =
    hold === "locked"
      ? "bg-sky-400 text-ink-950 ring-sky-300"
      : hold === "once"
        ? "bg-sky-400/20 text-sky-200 ring-sky-400/60"
        : "bg-ink-800 text-mist-200 ring-ink-700 active:bg-ink-600";
  return (
    <button
      aria-pressed={hold !== "off"}
      aria-label={`${label} ${hold === "locked" ? "(locked)" : hold === "once" ? "(held for the next key)" : ""}`}
      onMouseDown={(e) => e.preventDefault()} // keep the keyboard up
      onClick={onClick}
      className={`${KEY} font-semibold ${tone} ${hold === "locked" ? "underline underline-offset-4" : ""}`}
    >
      {label}
    </button>
  );
}

/** Whether the row starts opened up (kept per device). */
const OPEN = "consuls.keyRow.open";

interface Props {
  harness: Harness | null;
  holds: Holds;
  onHold(mod: keyof Holds): void;
  /** A key by tmux name (`C-c`, `PPage`, `1`): sent with the held modifiers. */
  onKey(name: string): void;
}

/**
 * The phone's terminal keys in one row that scrolls sideways, to keep the terminal tall. An
 * arrow at the edge says there's more; tapped, the row opens up into all the keys, and tapped
 * again, closes back to one line.
 */
export default function KeyBar({ harness, holds, onHold, onKey }: Props) {
  const [open, setOpen] = useState(() => uiStorage.getItem(OPEN) === "1");
  const toggle = () => {
    uiStorage.setItem(OPEN, open ? "0" : "1");
    setOpen(!open);
  };
  const [armed, setArmed] = useState<string | null>(null);
  const disarm = useRef(0);
  useEffect(() => () => window.clearTimeout(disarm.current), []);
  const press = (k: Key) => {
    window.clearTimeout(disarm.current);
    if (CONFIRM.has(k.label) && armed !== k.label) {
      setArmed(k.label);
      disarm.current = window.setTimeout(() => setArmed(null), 2500);
      return;
    }
    setArmed(null);
    onKey(k.name);
  };

  // Is there more to either side (for the fades and the arrow)?
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = () => {
    const el = scroller.current;
    if (el) setMore({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, harness]);

  const keys = keysFor(harness).map((k) =>
    k === "ctrl" || k === "alt" ? (
      <ModKey key={k} label={k === "ctrl" ? "Ctrl" : "Alt"} hold={holds[k]} onClick={() => onHold(k)} />
    ) : (
      <button
        key={k.label}
        title={k.title}
        onMouseDown={(e) => e.preventDefault()} // keep the keyboard up
        onClick={() => press(k)}
        className={`${KEY} active:bg-ink-600 ${armed === k.label ? "bg-rose-400/15 text-rose-300 ring-rose-400/50" : "bg-ink-800 text-mist-200 ring-ink-700"}`}
      >
        {armed === k.label ? `${k.label} again` : k.label}
      </button>
    ),
  );

  if (open) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {keys}
        <button onMouseDown={(e) => e.preventDefault()} onClick={toggle} aria-label="Fewer keys" className={`${KEY} bg-ink-850 text-mist-400 ring-ink-700`}>
          <ChevronUp className="mx-auto h-4.5 w-4.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <div ref={scroller} onScroll={measure} className="no-scrollbar flex gap-1.5 overflow-x-auto pr-10">
        {keys}
      </div>
      <div className={`pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-ink-900 to-transparent transition-opacity ${more.left ? "opacity-100" : "opacity-0"}`} />
      {/* More to the right: an arrow over a fade; at the end, a quieter one. Either opens the row up. */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        aria-label="All keys"
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-end bg-gradient-to-l from-ink-900 from-40% to-transparent pr-1"
      >
        {more.right ? <ChevronRight className="h-5 w-5 animate-pulse text-mist-200" /> : <ChevronDown className="h-4.5 w-4.5 text-mist-500" />}
      </button>
    </div>
  );
}
