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
import { paneIdentity } from "../lib/panes";
import { useViewPrefs, zoom } from "../store/viewPrefs";
import type React from "react";

const FONT = `"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace`;

export interface TerminalHandle {
  term: Terminal | null;
  search: SearchAddon | null;
  focus(): void;
  /** Rendered size of one character cell in CSS px (null before the first render). */
  cellSize(): { width: number; height: number } | null;
}

interface Props {
  pane: PaneInfo;
  onSearch(): void;
  onBack(): void;
  /** Focus the terminal on open (shells) rather than leaving it to the composer (agents). */
  autoFocus?: boolean;
  /** Move focus to the composer (Ctrl+L / Ctrl+K style shortcut). */
  onCompose?(): void;
  /** Font size in px, or null to fit the text to the pane's width. */
  fontSize: number | null;
  /** Extra overlay content positioned over the terminal's box (e.g. the resize grip). */
  children?: React.ReactNode;
  /**
   * Direct pane (no tmux): keys go out in xterm's own encoding, and the core, not xterm,
   * answers terminal queries (it answers even while the pane isn't open here).
   */
  raw?: boolean;
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

const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { pane, onSearch, onBack, autoFocus = true, onCompose, fontSize, children, raw = false },
  ref,
) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sizeRef = useRef({ cols: pane.width, rows: pane.height });
  const id = paneIdentity(pane);
  // Read by the (long-lived) terminal callbacks without rebuilding the terminal.
  const fontRef = useRef(fontSize);
  const fitRef = useRef<() => void>(() => {});
  useEffect(() => {
    fontRef.current = fontSize;
    fitRef.current();
  }, [fontSize]);

  useImperativeHandle(ref, () => ({
    get term() {
      return termRef.current;
    },
    get search() {
      return searchRef.current;
    },
    focus: () => termRef.current?.focus(),
    cellSize: () => {
      const term = termRef.current;
      if (!term) return null;
      // xterm doesn't expose cell metrics publicly; the fit addon reads the same field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cell = (term as any)._core?._renderService?.dimensions?.css?.cell;
      if (cell?.width && cell?.height) return { width: cell.width, height: cell.height };
      const size = term.options.fontSize ?? 13;
      return { width: size * measureCharRatio(), height: Math.ceil(size * (term.options.lineHeight ?? 1)) };
    },
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

    // Direct panes: the core answers terminal queries, so xterm must not answer them too.
    const swallowed = raw ? swallowQueries(term) : [];

    // The user's zoom if they set one; otherwise fit the font so the pane's columns fill the
    // available width (a zoomed-in terminal wider than the view scrolls horizontally).
    const fit = () => {
      const wrap = el.parentElement;
      if (!wrap) return;
      const avail = wrap.clientWidth - 24;
      const auto = Math.max(8, Math.min(15, Math.floor((avail / (sizeRef.current.cols * measureCharRatio())) * 4) / 4));
      const size = fontRef.current ?? auto;
      if (term.options.fontSize !== size) term.options.fontSize = size;
    };
    fitRef.current = fit;
    const zoomBy = (dir: 1 | -1) => zoom(id, term.options.fontSize ?? 13, dir);

    // Ctrl+wheel zooms the terminal (never the page).
    term.attachCustomWheelEventHandler((ev) => {
      if (!ev.ctrlKey) return true;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1 : -1);
      return false;
    });
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

    // Typed text: batch briefly so fast typing becomes few commands.
    let textBuf = "";
    let textTimer = 0;
    const flushText = () => {
      textTimer = 0;
      if (textBuf && b) {
        if (raw) b.sendInput(key, textBuf);
        else b.sendText(key, textBuf);
      }
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
      // Ctrl+= / Ctrl+- / Ctrl+0: text zoom (handled here so they never reach the pane).
      if (mod && !e.altKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_" || e.key === "0")) {
        e.preventDefault();
        if (e.key === "0") useViewPrefs.getState().setFontSize(id, null);
        else zoomBy(e.key === "-" || e.key === "_" ? -1 : 1);
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
      if (raw) {
        // xterm encodes keys itself. Shift+Enter → LF: a newline in agent prompts, as with tmux panes.
        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          textBuf += "\n";
          flushText();
          return false;
        }
        return true;
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
      // tmux panes: anything starting with ESC is xterm answering a terminal query, which tmux
      // already did. Direct panes: keys, mouse and focus reports all go out as-is.
      if (!raw && data.startsWith("\x1b")) return;
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
      swallowed.forEach((d) => d.dispose());
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
      <div className="relative inline-block align-top">
        <div
          ref={hostRef}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        />
        {children}
      </div>
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

/**
 * Stops xterm from replying to terminal queries (device attributes, cursor position, mode and
 * colour reports, …). Returning true marks a sequence handled; OSC colour *sets* still apply.
 */
function swallowQueries(term: Terminal): { dispose(): void }[] {
  const p = term.parser;
  const yes = () => true;
  return [
    p.registerCsiHandler({ final: "c" }, yes), // DA1
    p.registerCsiHandler({ prefix: ">", final: "c" }, yes), // DA2
    p.registerCsiHandler({ prefix: "=", final: "c" }, yes), // DA3
    p.registerCsiHandler({ final: "n" }, yes), // DSR (status, cursor position)
    p.registerCsiHandler({ prefix: "?", final: "n" }, yes), // DECDSR
    p.registerCsiHandler({ intermediates: "$", final: "p" }, yes), // DECRQM
    p.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, yes), // DECRQM (private)
    p.registerCsiHandler({ prefix: ">", final: "q" }, yes), // XTVERSION
    p.registerCsiHandler({ prefix: "?", final: "u" }, yes), // kitty keyboard flags
    p.registerDcsHandler({ intermediates: "$", final: "q" }, yes), // DECRQSS
    ...[4, 10, 11, 12].map((n) => p.registerOscHandler(n, (data) => data.includes("?"))), // colour queries
  ];
}

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
