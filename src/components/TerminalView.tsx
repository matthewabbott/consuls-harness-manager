import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { tmuxKey } from "../term/keymap";
import { type HeldMods, NO_MODS, rawBytes, tmuxName } from "../term/softKeys";
import { isPrefix } from "../term/tmuxPrefix";
import { theme } from "../term/palette";
import { rawCopy, selectionRows, smartCopy } from "../term/smartCopy";
import { attachStream } from "../term/streams";
import { paneIdentity } from "../lib/panes";
import { appMod, isMac, keyLabel } from "../lib/platform";
import { useViewPrefs, zoom } from "../store/viewPrefs";
import { useApp } from "../store/app";
import { useEditor } from "../store/editor";
import { useRecording } from "../store/recording";
import { findPaths, resolvePath } from "../term/links";
import { linkAt, type TappedLink } from "../term/linkAt";
import { findUrls, type RowText } from "../term/urls";
import { StreamRedactor } from "../term/redactStream";
import { imageFiles, pasteImagesInto } from "../store/attachments";
import type React from "react";

const FONT = `"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace`;

export interface TerminalHandle {
  term: Terminal | null;
  search: SearchAddon | null;
  focus(): void;
  /** Rendered size of one character cell in CSS px (null before the first render). */
  cellSize(): { width: number; height: number } | null;
  /**
   * A key from the phone's key bar (a tmux key name like `Left`, or one character): with the held
   * modifiers, then through the tmux prefix like any key press.
   */
  sendKey(name: string): void;
  /** Keys as they are (no held modifiers, no prefix), in one batch: one message, one burst. */
  press(names: string[]): void;
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
  /** tmux panes: the server's prefix key (`C-b`); the key after it goes to `onPrefixKey`. */
  prefix?: string | null;
  onPrefixKey?(key: string, tmuxName: string | null): void;
  /** The prefix was pressed and the next key is awaited (or that ended). */
  onPrefixPending?(pending: boolean): void;
  /** The phone's key bar: Ctrl/Alt held for the next key, typed or from the bar. */
  heldMods?: HeldMods | null;
  /** A held Ctrl/Alt was used (a one-shot hold lets go). */
  onModsUsed?(): void;
  /** The phone: a tap on a link (there's no hover or modifier key to ⌘-click with). */
  onLink?(link: TappedLink): void;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

interface Menu {
  x: number;
  y: number;
}

/** Rendered size of one character cell in CSS px. */
function cellSizeOf(term: Terminal): { width: number; height: number } {
  // xterm doesn't expose cell metrics publicly; the fit addon reads the same field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cell = (term as any)._core?._renderService?.dimensions?.css?.cell;
  if (cell?.width && cell?.height) return { width: cell.width, height: cell.height };
  const size = term.options.fontSize ?? 13;
  return { width: size * measureCharRatio(), height: Math.ceil(size * (term.options.lineHeight ?? 1)) };
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
  { pane, onSearch, onBack, autoFocus = true, onCompose, fontSize, children, raw = false, prefix = null, onPrefixKey, onPrefixPending, heldMods, onModsUsed, onLink },
  ref,
) {
  const [menu, setMenu] = useState<Menu | null>(null);
  // The terminal is built once per pane; key handling reads the latest props from here.
  const propsRef = useRef({ prefix, onPrefixKey, onPrefixPending, heldMods, onModsUsed, onLink });
  propsRef.current = { prefix, onPrefixKey, onPrefixPending, heldMods, onModsUsed, onLink };
  const routeRef = useRef<(name: string) => void>(() => {});
  const pressRef = useRef<(names: string[]) => void>(() => {});
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sizeRef = useRef({ cols: pane.width, rows: pane.height });
  // The latest pane (its working directory changes) for link resolution in terminal callbacks.
  const paneRef = useRef(pane);
  paneRef.current = pane;
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
    cellSize: () => (termRef.current ? cellSizeOf(termRef.current) : null),
    sendKey: (name) => routeRef.current(name),
    press: (names) => pressRef.current(names),
  }));

  useEffect(() => {
    const el = hostRef.current!;
    const key = pane.key;
    const host = pane.host;
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
    installLinks(term, () => paneRef.current);
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

    // Ctrl+wheel zooms the terminal (never the page); on macOS a pinch (which arrives as
    // Ctrl+wheel) or ⌘+wheel.
    term.attachCustomWheelEventHandler((ev) => {
      if (!ev.ctrlKey && !(isMac && ev.metaKey)) return true;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1 : -1);
      return false;
    });
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement!);
    fit();

    // Recording mode masks personal details before xterm sees them.
    const redactor = new StreamRedactor(
      () => useRecording.getState().stream,
      (bytes) => term.write(bytes),
    );
    const detach = attachStream(key, {
      reset(cols, rows, bytes) {
        sizeRef.current = { cols, rows };
        term.reset();
        term.resize(cols, rows);
        fit();
        term.write(redactor.all(bytes), () => term.scrollToBottom());
      },
      raw(bytes) {
        term.write(redactor.push(bytes));
      },
    });

    let b: Awaited<ReturnType<typeof backend>> | null = null;
    backend().then((be) => {
      b = be;
      be.streamPane(key, true);
    });
    // Recording mode switched: redraw from a fresh snapshot, so what's already on screen is
    // masked (or shown again).
    const unRecording = useRecording.subscribe((s, p) => {
      if (s.on !== p.on) b?.streamPane(key, true);
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

    let prefixPending = false;
    const setPending = (on: boolean) => {
      prefixPending = on;
      propsRef.current.onPrefixPending?.(on);
    };

    // The phone's keys (see TerminalHandle.sendKey), and characters typed with them held.
    const route = (name: string) => {
      const held = propsRef.current.heldMods ?? NO_MODS;
      if (held.ctrl || held.alt) propsRef.current.onModsUsed?.();
      if (raw) {
        textBuf += rawBytes(name, held);
        flushText();
        return;
      }
      const full = tmuxName(name, held);
      const prefix = propsRef.current.prefix;
      if (prefix && prefixPending) {
        setPending(false);
        propsRef.current.onPrefixKey?.(name, full);
        return;
      }
      if (prefix && isPrefix(name, full, prefix)) {
        flushText();
        setPending(true);
        return;
      }
      if ([...full].length === 1) {
        textBuf += full;
        flushText();
      } else {
        sendKeys([full]);
      }
    };
    routeRef.current = route;
    pressRef.current = (names: string[]) => {
      if (names.length === 0) return;
      if (raw) {
        textBuf += names.map((n) => rawBytes(n, NO_MODS)).join("");
        flushText();
      } else {
        sendKeys(names);
      }
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return !e.ctrlKey && !e.altKey; // let keypress produce text
      // tmux panes: the server's prefix (Ctrl+B) and the key after it (see term/tmuxPrefix.ts).
      const prefix = propsRef.current.prefix;
      if (prefix && !MODIFIER_KEYS.has(e.key)) {
        if (prefixPending) {
          e.preventDefault();
          setPending(false);
          propsRef.current.onPrefixKey?.(e.key, tmuxKey(e));
          return false;
        }
        if (isPrefix(e.key, tmuxKey(e), prefix)) {
          e.preventDefault();
          flushText();
          setPending(true);
          return false;
        }
      }
      // App shortcuts first: ⌘ on macOS (where Ctrl belongs to the terminal), Ctrl elsewhere.
      const mod = appMod(e);
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
      // Mod+= / Mod+- / Mod+0: text zoom (handled here so they never reach the pane).
      if (mod && !e.altKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_" || e.key === "0")) {
        e.preventDefault();
        if (e.key === "0") useViewPrefs.getState().setFontSize(id, null);
        else zoomBy(e.key === "-" || e.key === "_" ? -1 : 1);
        return false;
      }
      if (mod && (e.key.toLowerCase() === "c" || (!isMac && e.key === "Insert")) && (e.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) {
          // Mod+Shift+C copies exactly what's on screen; Mod+C un-wraps agent output.
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
      // One character typed with the key bar's Ctrl/Alt held, or after the tmux prefix on a
      // keyboard that sends no key events for it (the phone's).
      const held = propsRef.current.heldMods;
      if ([...data].length === 1 && (held?.ctrl || held?.alt || (prefixPending && !raw))) {
        route(data);
        return;
      }
      textBuf += data;
      if (!textTimer) textTimer = window.setTimeout(flushText, 8);
    });

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const images = imageFiles(e.clipboardData);
      if (text && b) {
        flushText();
        b.pasteText(key, text.replace(/\r\n/g, "\n"));
      } else if (images.length) {
        flushText();
        void pasteImagesInto(key, host, images);
      }
    };
    el.addEventListener("paste", onPaste, true);

    // The phone: a short tap on a link opens it (through onLink) instead of the keyboard.
    const tap = { x: 0, y: 0, at: 0 };
    const onDown = (e: PointerEvent) => {
      tap.x = e.clientX;
      tap.y = e.clientY;
      tap.at = e.isPrimary ? Date.now() : 0;
    };
    const onUp = (e: PointerEvent) => {
      const handler = propsRef.current.onLink;
      if (!handler || !tap.at || Date.now() - tap.at > 600 || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) return;
      const screen = el.querySelector(".xterm-screen");
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      const cell = cellSizeOf(term);
      const col = Math.floor((e.clientX - rect.left) / cell.width);
      const row = Math.floor((e.clientY - rect.top) / cell.height);
      if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return;
      const link = linkAt(term.buffer.active, term.cols, col, term.buffer.active.viewportY + row);
      if (!link) return;
      e.preventDefault();
      term.blur();
      handler(link);
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointerup", onUp, true);

    if (autoFocus) term.focus();
    return () => {
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointerup", onUp, true);
      dataSub.dispose();
      swallowed.forEach((d) => d.dispose());
      if (textTimer) window.clearTimeout(textTimer);
      flushText();
      detach();
      unRecording();
      redactor.flush(); // drops anything held back (and its timer)
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
    if (text) {
      (await backend()).pasteText(pane.key, text.replace(/\r\n/g, "\n"));
    } else {
      // No text: maybe a screenshot.
      const items = await navigator.clipboard.read().catch(() => []);
      const images = await Promise.all(
        items.flatMap((item) => item.types.filter((t) => t.startsWith("image/")).slice(0, 1).map((t) => item.getType(t))),
      );
      if (images.length) void pasteImagesInto(pane.key, pane.host, images);
    }
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
            <MenuItem disabled={!hasSel} hint={keyLabel("Mod+C")} onClick={() => { copy(true); setMenu(null); }}>
              Copy
            </MenuItem>
            <MenuItem disabled={!hasSel} hint={keyLabel("Mod+Shift+C")} onClick={() => { copy(false); setMenu(null); }}>
              Copy exactly as shown
            </MenuItem>
            <MenuItem hint={keyLabel("Mod+V")} onClick={() => { void pasteFromClipboard(); setMenu(null); }}>
              Paste
            </MenuItem>
            <div className="my-1 h-px bg-ink-700" />
            <MenuItem hint={keyLabel("Mod+F")} onClick={() => { onSearch(); setMenu(null); }}>
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

/** Rows looked at above and below the pointer for a URL that wraps onto several of them. */
const URL_ROWS = 20;

/** Opens a URL from the terminal: https in the browser; anything else is only copied. */
function openUrl(uri: string) {
  if (/^https:\/\//i.test(uri)) {
    void backend().then((b) => b.openExternal(uri));
  } else {
    void navigator.clipboard.writeText(uri);
    useApp.getState().notify("info", `Copied ${uri} (only https links open from a terminal)`);
  }
}

/** Opens `ref` (as printed in the pane) in the editor, at its line if it has one. */
async function openPath(pane: PaneInfo, ref: string, line?: number, col?: number) {
  const home = useApp.getState().hosts[pane.host]?.facts?.home;
  const path = resolvePath(ref, pane.currentPath, home);
  const b = await backend();
  const stat = await b.statFile(pane.host, path).catch(() => null);
  if (!stat) {
    useApp.getState().notify("warning", `Couldn't find ${path} on ${pane.host === "@local" ? "this PC" : pane.host}`);
    return;
  }
  await useEditor.getState().open(pane.host, path, pane.key, line ? { line, col } : undefined);
}

/**
 * Ctrl+click (⌘-click on macOS) links: URLs (and OSC 8 hyperlinks) and file references like `src/App.tsx:42`,
 * resolved against the pane's working directory and opened in the editor.
 */
function installLinks(term: Terminal, pane: () => PaneInfo) {
  const withMod = (e: MouseEvent) => appMod(e);
  // URLs, whole even when wrapped across rows (by the terminal, or by the program itself).
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      const first = Math.max(0, y - 1 - URL_ROWS);
      const rows: RowText[] = [];
      for (let i = first; i <= Math.min(buf.length - 1, y - 1 + URL_ROWS); i++) {
        const line = buf.getLine(i);
        rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
      }
      const here = y - 1 - first;
      const links = findUrls(rows, term.cols)
        .filter((u) => u.start.row <= here && u.end.row >= here)
        .map((u) => ({
          range: { start: { x: u.start.col + 1, y: first + u.start.row + 1 }, end: { x: u.end.col + 1, y: first + u.end.row + 1 } },
          text: u.url,
          decorations: { underline: true, pointerCursor: true },
          activate: (e: MouseEvent) => {
            if (withMod(e)) openUrl(u.url);
          },
        }));
      callback(links.length ? links : undefined);
    },
  });
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (e, uri) => {
      if (!withMod(e)) return;
      const file = uri.match(/^file:\/\/[^/]*(\/.*)$/);
      if (file) void openPath(pane(), decodeURIComponent(file[1]));
      else openUrl(uri);
    },
  };
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const refs = findPaths(text);
      callback(
        refs.length
          ? refs.map((r) => ({
              range: { start: { x: r.index + 1, y }, end: { x: r.index + r.length, y } },
              text: text.slice(r.index, r.index + r.length),
              decorations: { underline: true, pointerCursor: true },
              activate: (e: MouseEvent) => {
                if (withMod(e)) void openPath(pane(), r.path, r.line, r.col);
              },
            }))
          : undefined,
      );
    },
  });
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
