// A find field in place of a screen's header, shared by the terminal (xterm's search add-on) and
// the copy view (marks in its text). Matches count from the oldest; ↑ and the keyboard's Search
// key go to older ones, since a search starts from the latest.

import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { useEffect, useRef } from "react";

export interface FindResult {
  /** The current match (0 = oldest), or -1 when there are too many to number. */
  index: number;
  count: number;
}

export function countText(result: FindResult | null): string {
  if (!result || result.count === 0) return "0/0";
  return result.index < 0 ? `${result.count}+` : `${result.index + 1}/${result.count}`;
}

interface Props {
  query: string;
  onQuery(query: string): void;
  result: FindResult | null;
  onOlder(): void;
  onNewer(): void;
  onClose(): void;
  /** More buttons, before Done. */
  children?: React.ReactNode;
}

export default function FindBar({ query, onQuery, result, onOlder, onNewer, onClose, children }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const none = !result || result.count === 0;
  // Buttons keep the field focused, so the keyboard stays up between steps.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-ink-800 pr-2.5 pl-2 ring-1 ring-ink-700 focus-within:ring-sky-400/50">
        <Search className="h-4 w-4 shrink-0 text-mist-500" />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onOlder();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Find"
          aria-label="Find"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[16px] text-mist-100 outline-none placeholder:text-mist-500 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && <span className={`shrink-0 font-mono text-[12px] ${none ? "text-rose-300" : "text-mist-400"}`}>{countText(result)}</span>}
      </label>
      <button onMouseDown={keepFocus} onClick={onOlder} disabled={none} aria-label="Older match" className="rounded-full p-1.5 text-mist-200 active:bg-ink-700 disabled:text-mist-600">
        <ChevronUp className="h-6 w-6" />
      </button>
      <button onMouseDown={keepFocus} onClick={onNewer} disabled={none} aria-label="Newer match" className="rounded-full p-1.5 text-mist-200 active:bg-ink-700 disabled:text-mist-600">
        <ChevronDown className="h-6 w-6" />
      </button>
      {children}
      <button onClick={onClose} className="rounded-full px-2 py-1.5 text-[15px] font-medium text-ember-400 active:bg-ink-700">
        Done
      </button>
    </div>
  );
}
