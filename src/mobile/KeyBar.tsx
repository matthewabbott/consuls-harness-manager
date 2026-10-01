// The phone's terminal keys (like Termius's): Ctrl and Alt that stay held for the next key
// (tap once; tap again to lock, again to let go), and keys the iOS keyboard doesn't have.

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

const KEYS: { label: string; name: string }[] = [
  { label: "Esc", name: "Escape" },
  { label: "Tab", name: "Tab" },
  { label: "←", name: "Left" },
  { label: "↑", name: "Up" },
  { label: "↓", name: "Down" },
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

export default function KeyBar({ holds, onHold, onKey }: { holds: Holds; onHold(mod: keyof Holds): void; onKey(name: string): void }) {
  return (
    <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto">
      <ModKey label="Ctrl" hold={holds.ctrl} onClick={() => onHold("ctrl")} />
      <ModKey label="Alt" hold={holds.alt} onClick={() => onHold("alt")} />
      {KEYS.map((k) => (
        <button
          key={k.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onKey(k.name)}
          className={`${KEY} bg-ink-800 text-mist-200 ring-ink-700 active:bg-ink-600`}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
