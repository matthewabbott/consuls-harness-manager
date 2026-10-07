// How a drag scrolls a full-screen program (irssi, less, vim), which keeps its own history: by
// pages (PgUp / PgDn, any program), or by lines in irssi, which needs two key bindings there
// (irssi has no key that scrolls a line, only a command that does). Kept per pane, per device.

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { uiStorage } from "../lib/uiState";
import { Sheet } from "./Sheet";

/** irssi binds Ctrl+Alt+↑ / ↓ (what `C-M-Up` / `C-M-Down` send) to a line of scrollback. */
export const IRSSI_BINDS = ["/bind meta2-1;7A command scrollback goto -1", "/bind meta2-1;7B command scrollback goto +1"];
export const LINE_KEYS = { up: "C-M-Up", down: "C-M-Down" };

const KEY = "consuls.scrollLines";

function linePanes(): string[] {
  try {
    const v = JSON.parse(uiStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const scrollsByLines = (pane: string) => linePanes().includes(pane);

export function setScrollsByLines(pane: string, on: boolean) {
  const rest = linePanes().filter((p) => p !== pane);
  uiStorage.setItem(KEY, JSON.stringify(on ? [...rest, pane] : rest));
}

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-xl bg-ink-900 py-1.5 pr-1.5 pl-3 ring-1 ring-ink-700">
      <code className="selectable min-w-0 flex-1 font-mono text-[12.5px] break-all text-mist-100">{text}</code>
      <button
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          })
        }
        aria-label="Copy"
        className={`shrink-0 rounded-lg p-2 ring-1 ${done ? "bg-jade-400/15 text-jade-300 ring-jade-400/40" : "bg-ink-800 text-mist-200 ring-ink-700"}`}
      >
        {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Choice({ on, title, hint, onClick }: { on: boolean; title: string; hint: string; onClick(): void }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ring-1 ${on ? "bg-ember-400/10 ring-ember-400/50" : "ring-ink-700"}`}>
      <span className={`h-4 w-4 shrink-0 rounded-full ring-2 ${on ? "bg-ember-400 ring-ember-400/40" : "ring-ink-600"}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-mist-100">{title}</span>
        <span className="block text-[12.5px] text-mist-500">{hint}</span>
      </span>
    </button>
  );
}

export default function ScrollSheet({ lines, onLines, onClose }: { lines: boolean; onLines(on: boolean): void; onClose(): void }) {
  return (
    <Sheet onClose={onClose}>
      <div className="space-y-2.5 px-1 pb-2">
        <div className="text-[16px] font-semibold text-mist-100">Scrolling in this pane</div>
        <p className="text-[13.5px] leading-snug text-mist-400">
          A full-screen program keeps its own history, so a drag here pages through it with PgUp / PgDn. irssi can scroll line by line instead: paste these
          two lines into irssi once (then <span className="font-mono">/save</span> to keep them).
        </p>
        {IRSSI_BINDS.map((b) => (
          <CopyLine key={b} text={b} />
        ))}
        <Choice on={!lines} title="Pages" hint="PgUp / PgDn: any program" onClick={() => onLines(false)} />
        <Choice on={lines} title="Lines" hint="irssi, with the two bindings above" onClick={() => onLines(true)} />
      </div>
    </Sheet>
  );
}
