// The pane's output as text to copy: each message, tool call and prompt as a block with its own
// Copy button (term/textBlocks.ts), and selectable as ordinary text. Find marks matches in it.

import type { Terminal } from "@xterm/xterm";
import { Check, ChevronDown, Copy, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { harnessLabel } from "../components/HarnessBadge";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { findAll } from "../term/find";
import { type BlockKind, bufferRows, splitBlocks, type TextBlock } from "../term/textBlocks";
import FindBar from "./FindBar";

/** The latest rows shown at first; the rest on request. */
const RECENT_ROWS = 3000;
/** Tool output is folded past this many lines. */
const TOOL_LINES = 8;

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] ring-1 active:bg-ink-600 ${
        done ? "bg-jade-400/15 text-jade-300 ring-jade-400/40" : "bg-ink-700 text-mist-100 ring-ink-600"
      }`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

/** `text` with the matches at `ranges` marked; `first` numbers the first of them, `active` is the current one. */
function marked(text: string, ranges: [number, number][], first: number, active: number) {
  if (ranges.length === 0) return text;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) out.push(text.slice(at, start));
    const current = first + i === active;
    out.push(
      <mark key={i} data-current={current || undefined} className={`rounded-sm ${current ? "bg-ember-400 text-ink-950" : "bg-sky-400/30 text-mist-100"}`}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

interface Found {
  ranges: [number, number][];
  first: number;
  active: number;
}

function Block({ block, agent, found }: { block: TextBlock; agent: string; found: Found }) {
  const lines = block.text.split("\n");
  const long = block.kind === "tool" && lines.length > TOOL_LINES;
  const [unfolded, setOpen] = useState(!long);
  // A block with matches shows them all.
  const open = unfolded || found.ranges.length > 0;
  const names: Record<BlockKind, string> = { you: "You", agent, tool: "Tool", output: "Output" };
  const tone: Record<BlockKind, string> = {
    you: "bg-ember-400/10 ring-ember-400/25",
    agent: "bg-ink-800 ring-ink-700",
    tool: "bg-ink-850 ring-ink-700 text-mist-400",
    output: "bg-ink-800 ring-ink-700",
  };
  return (
    <section className={`rounded-2xl px-3 py-2.5 ring-1 ${tone[block.kind]}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex-1 text-[11.5px] font-medium tracking-wide text-mist-500 uppercase">{names[block.kind]}</span>
        <CopyButton text={block.text} />
      </div>
      <pre className="selectable font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-mist-100">
        {open ? marked(block.text, found.ranges, found.first, found.active) : lines.slice(0, TOOL_LINES).join("\n")}
      </pre>
      {long && found.ranges.length === 0 && (
        <button onClick={() => setOpen(!open)} className="mt-1 flex items-center gap-1 text-[12.5px] text-mist-500">
          <ChevronDown className={`h-3.5 w-3.5 ${open ? "rotate-180" : ""}`} /> {open ? "Less" : `${lines.length - TOOL_LINES} more lines`}
        </button>
      )}
    </section>
  );
}

/** `query`: a search to start with (the terminal's, when Copy is opened from its find bar). */
export default function CopySheet({ term, pane, query: initial = "", onClose }: { term: Terminal; pane: PaneInfo; query?: string; onClose(): void }) {
  const [finding, setFinding] = useState(initial !== "");
  const [query, setQuery] = useState(initial);
  const needle = useDeferredValue(finding ? query : "");
  const [earlier, setEarlier] = useState(false);
  // A search covers all the output (and keeps it shown after, so Done leaves you where you are).
  const everything = earlier || needle !== "";
  useEffect(() => {
    if (needle) setEarlier(true);
  }, [needle]);
  const total = term.buffer.active.length;
  const blocks = useMemo(() => splitBlocks(bufferRows(term.buffer.active, everything ? Infinity : RECENT_ROWS), term.cols), [term, everything]);
  const all = useMemo(() => blocks.map((b) => b.text).join("\n\n"), [blocks]);
  const matches = useMemo(() => {
    let count = 0;
    const per = blocks.map((b) => {
      const ranges = findAll(b.text, needle);
      const first = count;
      count += ranges.length;
      return { ranges, first };
    });
    return { per, count };
  }, [blocks, needle]);
  // The current match: the latest at first, as in the terminal.
  const [active, setActive] = useState(-1);
  useEffect(() => setActive(matches.count - 1), [matches]);
  const step = (by: number) => matches.count && setActive((a) => (a + by + matches.count) % matches.count);
  const main = useRef<HTMLElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // Start at the latest. (Braces: newer browsers' scrollIntoView returns a promise, which an
  // effect mustn't.)
  useEffect(() => {
    end.current?.scrollIntoView();
  }, [everything]);
  useEffect(() => {
    main.current?.querySelector("mark[data-current]")?.scrollIntoView({ block: "center" });
  }, [active, matches]);
  const agent = pane.harness && pane.harness !== "shell" ? harnessLabel(pane.harness) : "Agent";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink-900">
      <header className="safe-top flex min-h-[44px] shrink-0 items-center gap-2 border-b border-ink-700/80 px-1.5 pb-2">
        {finding ? (
          <div className="flex min-w-0 flex-1 items-center pl-1">
            <FindBar
              query={query}
              onQuery={setQuery}
              result={needle ? { index: active, count: matches.count } : null}
              onOlder={() => step(-1)}
              onNewer={() => step(1)}
              onClose={() => setFinding(false)}
            />
          </div>
        ) : (
          <>
            <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
              <X className="h-6 w-6" />
            </button>
            <h1 className="flex-1 text-[17px] font-semibold text-mist-100">Copy text</h1>
            <button onClick={() => setFinding(true)} aria-label="Find" className="rounded-full p-2 text-mist-300 active:bg-ink-700">
              <Search className="h-5 w-5" />
            </button>
            <div className="pr-2">
              <CopyButton text={all} label="Copy all" />
            </div>
          </>
        )}
      </header>
      <main ref={main} className="safe-bottom min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pt-3">
        {!everything && total > RECENT_ROWS && (
          <button onClick={() => setEarlier(true)} className="w-full rounded-xl py-2 text-[13px] text-mist-400 ring-1 ring-ink-700 active:bg-ink-800">
            Earlier output…
          </button>
        )}
        {blocks.length === 0 && <p className="text-[14px] text-mist-500">Nothing to copy yet.</p>}
        {blocks.map((b, i) => (
          <Block key={`${everything}-${i}`} block={b} agent={agent} found={{ ...matches.per[i], active }} />
        ))}
        <div ref={end} className="h-2" />
      </main>
    </div>
  );
}
