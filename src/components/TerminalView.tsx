import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { tmuxKey } from "../term/keymap";
import { theme } from "../term/palette";
import { rawCopy, selectionRows, smartCopy } from "../term/smartCopy";
import { attachStream } from "../term/streams";

const FONT = `"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace`;

export interface TerminalHandle {
  term: Terminal | null;
  search: SearchAddon | null;
  focus(): void;
}

interface Props {
  pane: PaneInfo;
  onSearch(): void;
  onBack(): void;
  /** Focus the terminal on open (shells) rather than leaving it to the composer (agents). */
  autoFocus?: boolean;
  /** Move focus to the composer (Ctrl+L / Ctrl+K style shortcut). */
  onCompose?(): void;
}

interface Menu {
  x: number;
  y: number;
}

/** Width of one monospace cell per px of font size, measured once. */
let charRatio = 0;
function measureCharRatio(): number {
  if (charRatio) return charRatio;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `100px ${FONT}`;
  charRatio = ctx.measureText("MMMMMMMMMM").width / 1000;
  return charRatio || 0.6;
}

const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ pane, onSearch, onBack, autoFocus = true, onCompose }, ref) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sizeRef = useRef({ cols: pane.width, rows: pane.height });

  useImperativeHandle(ref, () => ({
    get term() {
      return termRef.current;
    },
    get search() {
      return searchRef.current;
    },
    focus: () => termRef.current?.focus(),
  }));

  useEffect(() => {
    const el = hostRef.current!;
    const key = pane.key;
    const term = new Terminal({
      cols: pane.width,
      rows: pane.height,
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 20000,
      allowProposedApi: true,
      cursorBlink: false,
      cursorStyle: "block",
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: true,
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        cursorAccent: theme.background,
        selectionBackground: "rgba(106,169,255,0.35)",
        black: theme.ansi[0], red: theme.ansi[1], green: theme.ansi[2], yellow: theme.ansi[3],
        blue: theme.ansi[4], magenta: theme.ansi[5], cyan: theme.ansi[6], white: theme.ansi[7],
        brightBlack: theme.ansi[8], brightRed: theme.ansi[9], brightGreen: theme.ansi[10], brightYellow: theme.ansi[11],
        brightBlue: theme.ansi[12], brightMagenta: theme.ansi[13], brightCyan: theme.ansi[14], brightWhite: theme.ansi[15],
      },
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(el);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null; // DOM renderer fallback
    }
    termRef.current = term;
    searchRef.current = search;

    // Fit the font so the pane's columns fill the available width.
    const fit = () => {
      const wrap = el.parentElement;
      if (!wrap) return;
      const avail = wrap.clientWidth - 24;
      const size = Math.max(8, Math.min(15, Math.floor((avail / (sizeRef.current.cols * measureCharRatio())) * 4) / 4));
      if (term.options.fontSize !== size) term.options.fontSize = size;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement!);
    fit();

    const detach = attachStream(key, {
      reset(cols, rows, bytes) {
        sizeRef.current = { cols, rows };
        term.reset();
        term.resize(cols, rows);
        fit();
        term.write(bytes, () => term.scrollToBottom());
      },
      raw(bytes) {
        term.write(bytes);
      },
    });

    let b: Awaited<ReturnType<typeof backend>> | null = null;
    backend().then((be) => {
      b = be;
      be.streamPane(key, true);
    });

    // Typed text: batch briefly so fast typing becomes few tmux commands.
    let textBuf = "";
    let textTimer = 0;
    const flushText = () => {
      textTimer = 0;
      if (textBuf && b) b.sendText(key, textBuf);
      textBuf = "";
    };
    const sendKeys = (keys: string[]) => {
      flushText();
      b?.sendKeys(key, keys);
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return !e.ctrlKey && !e.altKey; // let keypress produce text
      const mod = e.ctrlKey || e.metaKey;
      // App shortcuts first.
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        onSearch();
        return false;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        onBack();
        return false;
      }
      if (mod && (e.key.toLowerCase() === "c" || e.key === "Insert") && (e.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) {
          // Ctrl+Shift+C copies exactly what's on screen; Ctrl+C un-wraps agent output.
          const rows = selectionRows(term);
          navigator.clipboard.writeText(e.shiftKey ? rawCopy(rows) : smartCopy(rows, term.cols));
          term.clearSelection();
        }
        e.preventDefault();
        return false;
      }
      if (mod && e.key === "Enter" && onCompose) {
        e.preventDefault();
        onCompose();
        return false;
      }
      if (mod && e.key.toLowerCase() === "v") {
        return true; // let the browser fire a paste event (handled below)
      }
      const name = tmuxKey(e);
      if (name) {
        e.preventDefault();
        sendKeys([name]);
        return false;
      }
      return true;
    });

    const dataSub = term.onData((data) => {
      // Anything starting with ESC is xterm answering a terminal query; tmux already did.
      if (data.startsWith("\x1b")) return;
      textBuf += data;
      if (!textTimer) textTimer = window.setTimeout(flushText, 8);
    });

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text && b) {
        flushText();
        b.pasteText(key, text.replace(/\r\n/g, "\n"));
      }
    };
    el.addEventListener("paste", onPaste, true);

    if (autoFocus) term.focus();
    return () => {
      el.removeEventListener("paste", onPaste, true);
      dataSub.dispose();
      if (textTimer) window.clearTimeout(textTimer);
      flushText();
      detach();
      ro.disconnect();
      b?.streamPane(key, false);
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
    // The terminal is rebuilt only when switching panes; size changes arrive as RESET frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.key]);

  const copy = (smart: boolean) => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    const rows = selectionRows(term);
    navigator.clipboard.writeText(smart ? smartCopy(rows, term.cols) : rawCopy(rows));
  };
  const pasteFromClipboard = async () => {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) (await backend()).pasteText(pane.key, text.replace(/\r\n/g, "\n"));
    termRef.current?.focus();
  };
  const hasSel = termRef.current?.hasSelection() ?? false;

  return (
    <>
      <div
        ref={hostRef}
        className="inline-block"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu && (
        <div className="fixed inset-0 z-50" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div
            className="animate-rise absolute w-52 rounded-xl bg-ink-800 p-1 shadow-2xl ring-1 ring-ink-600"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <MenuItem disabled={!hasSel} hint="Ctrl+C" onClick={() => { copy(true); setMenu(null); }}>
              Copy
            </MenuItem>
            <MenuItem disabled={!hasSel} hint="Ctrl+Shift+C" onClick={() => { copy(false); setMenu(null); }}>
              Copy exactly as shown
            </MenuItem>
            <MenuItem hint="Ctrl+V" onClick={() => { void pasteFromClipboard(); setMenu(null); }}>
              Paste
            </MenuItem>
            <div className="my-1 h-px bg-ink-700" />
            <MenuItem hint="Ctrl+F" onClick={() => { onSearch(); setMenu(null); }}>
              Search conversation
            </MenuItem>
          </div>
        </div>
      )}
    </>
  );
});

function MenuItem({ children, hint, onClick, disabled }: { children: React.ReactNode; hint?: string; onClick(): void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-mist-200 hover:bg-ink-700 disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
      {hint && <span className="font-mono text-[10.5px] text-mist-500">{hint}</span>}
    </button>
  );
}

export default TerminalView;
