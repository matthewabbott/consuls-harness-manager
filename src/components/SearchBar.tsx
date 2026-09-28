import type { SearchAddon } from "@xterm/addon-search";
import { ArrowDown, ArrowUp, CaseSensitive, Regex, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  search: SearchAddon | null;
  onClose(): void;
}

const DECORATIONS = {
  matchBackground: "#6aa9ff40",
  matchBorder: "#6aa9ff80",
  matchOverviewRuler: "#6aa9ff",
  activeMatchBackground: "#f5a25d",
  activeMatchBorder: "#ffc27f",
  activeMatchColorOverviewRuler: "#f5a25d",
};

export default function SearchBar({ search, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!search) return;
    const sub = search.onDidChangeResults((r) => setResult(r ? { index: r.resultIndex, count: r.resultCount } : null));
    return () => sub.dispose();
  }, [search]);

  const opts = { caseSensitive, regex, decorations: DECORATIONS };

  useEffect(() => {
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    try {
      search.findPrevious(query, { ...opts, incremental: true });
    } catch {
      /* invalid regex while typing */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, regex, search]);

  useEffect(() => () => search?.clearDecorations(), [search]);

  const next = () => query && search?.findNext(query, opts);
  const prev = () => query && search?.findPrevious(query, opts);

  return (
    <div className="animate-rise absolute top-3 right-4 z-10 flex items-center gap-1 rounded-xl bg-ink-800/95 p-1.5 shadow-2xl ring-1 ring-ink-600 backdrop-blur">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) next();
            else prev();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Search conversation"
        className="w-60 rounded-lg bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-mist-100 outline-none placeholder:text-mist-500"
      />
      <span className="w-16 text-center font-mono text-[11px] text-mist-400">
        {query ? (result && result.count > 0 ? `${result.index + 1}/${result.count}` : "0/0") : ""}
      </span>
      <Toggle on={caseSensitive} title="Match case" onClick={() => setCaseSensitive(!caseSensitive)}>
        <CaseSensitive className="h-4 w-4" />
      </Toggle>
      <Toggle on={regex} title="Regular expression" onClick={() => setRegex(!regex)}>
        <Regex className="h-3.5 w-3.5" />
      </Toggle>
      <Btn title="Previous (Enter)" onClick={prev}>
        <ArrowUp className="h-3.5 w-3.5" />
      </Btn>
      <Btn title="Next (Shift+Enter)" onClick={next}>
        <ArrowDown className="h-3.5 w-3.5" />
      </Btn>
      <Btn title="Close (Esc)" onClick={onClose}>
        <X className="h-3.5 w-3.5" />
      </Btn>
    </div>
  );
}

function Btn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded-md p-1.5 text-mist-400 hover:bg-ink-600 hover:text-mist-100">
      {children}
    </button>
  );
}

function Toggle({ on, title, onClick, children }: { on: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded-md p-1.5 ${on ? "bg-sky-400/20 text-sky-400" : "text-mist-400 hover:bg-ink-600 hover:text-mist-100"}`}
    >
      {children}
    </button>
  );
}
