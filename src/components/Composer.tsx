import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder } from "@codemirror/view";
import { ArrowUp, CornerDownLeft, LoaderCircle, Mic, TriangleAlert, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { paneIdentity } from "../lib/panes";
import { dictateOnServer, onServerPref, serverReady, useStt } from "../lib/dictation";
import { captureContext } from "../lib/recorder";
import { hangUp, primeSounds } from "../lib/sounds";
import { continuing, type Dictation, type DictationEvents, dictate, speechSupported } from "../lib/speech";
import { useApp } from "../store/app";
import { type Attachment, attachImages, attachmentsOf, imageFiles, removeAttachment, takeAttachments, useAttachmentsOf } from "../store/attachments";
import { getDraft, getHistory, pushHistory, setDraft } from "../store/composer";
import { harnessLabel } from "./HarnessBadge";

export interface ComposerHandle {
  focus(): void;
}

const theme = EditorView.theme(
  {
    "&": { color: "var(--color-mist-100)", backgroundColor: "transparent", fontSize: "13.5px", height: "100%" },
    ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--color-ember-400)", padding: "10px 0", lineHeight: "1.5" },
    ".cm-line": { padding: "0 14px" },
    ".cm-scroller": { overflow: "auto" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--color-ember-400)", borderLeftWidth: "2px" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(106,169,255,0.28) !important" },
    ".cm-placeholder": { color: "var(--color-mist-500)" },
    ".cm-heard": { color: "var(--color-mist-500)" },
  },
  { dark: true },
);

/**
 * Where dictation writes. What's final is written in for good (dictated text you then edit is
 * yours); this range holds only what may still change (dimmed: Safari's guesses, or "…" while
 * the server transcribes) and the space after it if the text that follows needs one. Edits
 * around it move it; an edit inside it ends the dictation (the next result would overwrite it).
 */
interface Dictated {
  from: number;
  to: number;
  markFrom: number;
  markTo: number;
}

const setDictated = StateEffect.define<Dictated | null>();
const heardMark = Decoration.mark({ class: "cm-heard" });

const dictated = StateField.define<Dictated | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDictated)) return e.value;
    if (!v || !tr.docChanged) return v;
    let inside = false;
    tr.changes.iterChangedRanges((a, b) => {
      if (a < v.to && b > v.from) inside = true;
    });
    if (inside) return null;
    const from = tr.changes.mapPos(v.from, 1);
    const to = Math.max(from, tr.changes.mapPos(v.to, -1));
    return { from, to, markFrom: tr.changes.mapPos(v.markFrom, 1), markTo: tr.changes.mapPos(v.markTo, -1) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v && v.markFrom < v.markTo ? Decoration.set([heardMark.range(v.markFrom, v.markTo)]) : Decoration.none)),
});

/** Where the last dictation ended: dictating again right there (a pause) starts a new paragraph. */
const setLastDictated = StateEffect.define<number | null>();
const lastDictated = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLastDictated)) return e.value;
    return v === null || !tr.docChanged ? v : tr.changes.mapPos(v, -1);
  },
});

type Phase = "idle" | "recording" | "finishing";

interface Props {
  pane: PaneInfo;
  /** Called when the user presses Escape in an empty composer (interrupt the agent). */
  onEscapeEmpty(): void;
  /**
   * Return sends (the desktop). Off on the phone, as phones usually do: Return is a new line
   * and the button sends (⌘/Ctrl+Enter still sends from a keyboard).
   */
  returnSends?: boolean;
  /** A mic button that types what you say (the phone), where the browser can recognize speech. */
  dictation?: boolean;
}

/** Sends the composer's text and pasted images; returns whether anything was sent. */
function submit(view: EditorView, id: string, key: number): boolean {
  const text = view.state.doc.toString();
  if (!text.trim() && attachmentsOf(id).length === 0) return false;
  if (text.trim()) pushHistory(id, text);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  takeAttachments(id).then(({ paths, failed }) => {
    if (failed) {
      useApp.getState().notify("warning", `${failed === 1 ? "An image" : `${failed} images`} couldn't be saved on the machine, so ${failed === 1 ? "it wasn't" : "they weren't"} sent.`);
    }
    if (text.trim() || paths.length) backend().then((b) => b.submitPrompt(key, text, paths));
  });
  return true;
}

const Composer = forwardRef<ComposerHandle, Props>(function Composer({ pane, onEscapeEmpty, returnSends = true, dictation = false }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [focused, setFocused] = useState(false);
  const [empty, setEmpty] = useState(true);
  const id = paneIdentity(pane);
  const key = pane.key;
  const host = pane.host;
  const attachments = useAttachmentsOf(id);
  const sttStatus = useStt((st) => st.status);
  const micShown = dictation && (speechSupported() || !!sttStatus?.installed);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const session = useRef<{ d: Dictation | null; started: boolean; server: boolean } | null>(null);
  const afterEnd = useRef<(() => void) | null>(null);
  const [waitingToSend, setWaitingToSend] = useState(false);

  useEffect(() => {
    if (!dictation) return;
    const { refresh } = useStt.getState();
    refresh();
    const t = window.setInterval(() => document.visibilityState === "visible" && refresh(), 30_000);
    return () => window.clearInterval(t);
  }, [dictation]);

  /** Ends dictation at once, keeping what's there (the dim part too). */
  const quiet = () => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    s.d?.abort();
    if (phaseRef.current === "recording") hangUp();
    setPhase("idle");
    const v = viewRef.current;
    const r = v?.state.field(dictated, false);
    if (v && r) v.dispatch({ effects: [setDictated.of(null), ...(s.started ? [setLastDictated.of(r.markTo)] : [])] });
  };
  const quietRef = useRef(quiet);
  quietRef.current = quiet;

  /** Dictation has put in its last words: a send that was waiting for them goes now. */
  const ended = () => {
    quiet();
    const go = afterEnd.current;
    afterEnd.current = null;
    setWaitingToSend(false);
    go?.();
  };

  const listen = () => {
    const v = viewRef.current;
    if (!v || phaseRef.current === "finishing") return;
    if (session.current) return session.current.d?.stop(); // the last words still come in
    // At the cursor, or after the text when the box isn't being typed in; spaced from its
    // neighbours, or a new paragraph when carrying on where the last dictation stopped.
    const doc = v.state.doc;
    const at = v.hasFocus ? v.state.selection.main.head : doc.length;
    const before = doc.sliceString(Math.max(0, at - 200), at);
    const lead = at > 0 && v.state.field(lastDictated, false) === at ? "\n\n" : before && !/[\s([{"'`]$/.test(before) ? " " : "";
    const trail = /[\p{L}\p{N}]/u.test(doc.sliceString(at, at + 1)) ? " " : "";
    const st = useStt.getState().status;
    const s = { d: null as Dictation | null, started: false, server: serverReady(st) };
    let done = 0; // characters of the heard text written in for good
    const onText = (heard: string, finalLength: number) => {
      const view = viewRef.current;
      const r = view?.state.field(dictated, false);
      if (!view || session.current !== s) return;
      if (!r) return quiet(); // edited inside: what's there stays
      const text = continuing(before + lead, heard); // same length
      const fin = Math.max(done, Math.min(finalLength, text.length));
      const add = text.slice(done, fin);
      const tail = text.slice(fin);
      const pre = !s.started && (add || tail) ? lead : "";
      if (add || tail) s.started = true;
      const insert = pre + add + tail + (s.started ? trail : "");
      const from = r.from + pre.length + add.length;
      const end = from + tail.length;
      const head = view.state.selection.main;
      view.dispatch({
        changes: { from: r.from, to: r.to, insert },
        effects: [setDictated.of({ from, to: r.from + insert.length, markFrom: from, markTo: end }), EditorView.scrollIntoView(end)],
        // A cursor in the dictated text follows it.
        selection: head.empty && head.head >= r.from && head.head <= r.to ? { anchor: end } : undefined,
        userEvent: "input.dictation",
      });
      done = fin;
    };
    const events: DictationEvents = {
      onText,
      onStopped: () => {
        if (session.current !== s) return;
        hangUp();
        setPhase("finishing");
      },
      onEnd: () => {
        if (session.current === s) ended();
      },
      onError: (message) => useApp.getState().notify("warning", message),
    };
    v.dispatch({ effects: setDictated.of({ from: at, to: at, markFrom: at, markTo: at }) });
    session.current = s;
    primeSounds();
    try {
      if (st && serverReady(st)) s.d = dictateOnServer(captureContext(), st, events);
      else {
        if (onServerPref() && st?.installed && st.level === "out") {
          useApp.getState().notify("info", `The server is too short of memory for dictation (${st.availableMb} MB free): Safari's recognizer is taking it.`);
        }
        s.d = dictate(events);
      }
    } catch (e) {
      useApp.getState().notify("warning", `Dictation couldn't start: ${e}`);
    }
    if (s.d) setPhase("recording");
    else quiet();
  };

  /** Sends; while dictating, once the last words are in. Returns whether anything went (or will). */
  const send = (): boolean => {
    const v = viewRef.current;
    if (!v) return false;
    if (!session.current) return submit(v, id, key);
    const go = () => {
      if (viewRef.current) submit(viewRef.current, id, key);
    };
    afterEnd.current = go;
    setWaitingToSend(true);
    session.current.d?.stop();
    window.setTimeout(() => afterEnd.current === go && ended(), 20_000);
    return true;
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useImperativeHandle(ref, () => ({ focus: () => viewRef.current?.focus() }));

  useEffect(() => {
    // Prompt history navigation: -1 = the live draft.
    let histIndex = -1;
    let liveDraft = "";

    const replace = (view: EditorView, text: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
    };

    const send = (): boolean => {
      if (sendRef.current()) histIndex = -1;
      return true;
    };

    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: getDraft(id),
        extensions: [
          history(),
          dictated,
          lastDictated,
          EditorView.lineWrapping,
          placeholder(
            returnSends ? `Message ${harnessLabel(pane.harness)}…  (Enter to send · Shift+Enter for a new line · paste images)` : `Message ${harnessLabel(pane.harness)}…`,
          ),
          theme,
          // Pasted images are saved on the pane's machine and sent with the prompt.
          EditorView.domEventHandlers({
            paste: (e) => {
              const files = imageFiles(e.clipboardData);
              if (!files.length) return false;
              e.preventDefault();
              attachImages(id, host, files);
              return true;
            },
          }),
          Prec.highest(
            keymap.of([
              { key: "Enter", run: returnSends ? send : insertNewline },
              { key: "Mod-Enter", run: send },
              { key: "Shift-Enter", run: insertNewline },
              {
                key: "Escape",
                run: (v) => {
                  if (v.state.doc.length === 0) {
                    onEscapeEmpty();
                    return true;
                  }
                  return false;
                },
              },
              {
                key: "ArrowUp",
                run: (v) => {
                  const pos = v.state.selection.main.head;
                  if (v.state.doc.lineAt(pos).number !== 1) return false;
                  const list = getHistory(id);
                  if (!list.length) return false;
                  if (histIndex === -1) liveDraft = v.state.doc.toString();
                  histIndex = Math.min(histIndex + 1, list.length - 1);
                  replace(v, list[list.length - 1 - histIndex]);
                  return true;
                },
              },
              {
                key: "ArrowDown",
                run: (v) => {
                  if (histIndex === -1) return false;
                  const pos = v.state.selection.main.head;
                  if (v.state.doc.lineAt(pos).number !== v.state.doc.lines) return false;
                  histIndex -= 1;
                  const list = getHistory(id);
                  replace(v, histIndex === -1 ? liveDraft : list[list.length - 1 - histIndex]);
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              setDraft(id, text);
              setEmpty(text.length === 0);
            }
            if (u.focusChanged) setFocused(u.view.hasFocus);
            // Edited inside the dictated text (or the box was cleared): stop listening.
            if (u.startState.field(dictated, false) && !u.state.field(dictated, false)) quietRef.current();
          }),
        ],
      }),
    });
    viewRef.current = view;
    setEmpty(view.state.doc.length === 0);
    return () => {
      quietRef.current();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);

  const sendClick = () => {
    send();
    viewRef.current?.focus();
  };

  // The server's memory, for the mic's colour and (while recording there) a reminder to pause.
  const level = phase !== "idle" ? (session.current?.server ? sttStatus?.level : null) : serverReady(sttStatus) ? sttStatus?.level : null;
  const micTone = level === "red" ? "text-rose-300 ring-1 ring-rose-400/60" : level === "yellow" ? "text-amber-300 ring-1 ring-amber-400/50" : "text-mist-300";
  const micTitle = phase === "recording" ? "Stop dictating" : phase === "finishing" ? "Putting in the last words…" : "Dictate";

  return (
    <div
      className={`relative flex h-full flex-col rounded-xl bg-ink-850 ring-1 transition-shadow ${
        focused ? "shadow-[0_0_0_3px_rgb(245_162_93/0.12)] ring-ember-400/50" : "ring-ink-700"
      }`}
    >
      {phase === "recording" && (level === "yellow" || level === "red") && sttStatus && (
        <div
          className={`pointer-events-none absolute right-0 bottom-full mb-1.5 rounded-full px-2.5 py-1 text-[12px] ring-1 backdrop-blur ${
            level === "red" ? "bg-rose-950/80 text-rose-200 ring-rose-400/50" : "bg-amber-950/80 text-amber-200 ring-amber-400/40"
          }`}
        >
          {level === "red" ? "Server memory very low" : "Server memory tight"} ({sttStatus.availableMb} MB): pause every {sttStatus.maxPieceSecs} s or so
        </div>
      )}
      {attachments.length > 0 && (
        <div className="scroll-thin flex shrink-0 gap-2 overflow-x-auto px-3 pt-2.5">
          {attachments.map((a) => (
            <Thumb key={a.id} a={a} onRemove={() => removeAttachment(id, a.id)} />
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-end">
        <div ref={hostRef} className="h-full min-w-0 flex-1 cursor-text" onMouseDown={() => setTimeout(() => viewRef.current?.focus(), 0)} />
        {micShown && (
          <button
            onMouseDown={(e) => e.preventDefault()} // the keyboard stays as it is: up or down
            onClick={listen}
            disabled={phase === "finishing"}
            title={micTitle}
            aria-label={micTitle}
            aria-pressed={phase === "recording"}
            className={`my-1.5 rounded-lg p-2 transition-colors ${phase === "recording" ? "animate-pulse bg-rose-500 text-white ring-4 ring-rose-500/30" : `${micTone} active:bg-ink-700`}`}
          >
            {phase === "finishing" ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
          </button>
        )}
        <button
          onMouseDown={(e) => e.preventDefault()} // keep the text box (and a phone's keyboard) focused
          onClick={sendClick}
          disabled={(empty && attachments.length === 0 && phase === "idle") || waitingToSend}
          title={returnSends ? "Send (Enter)" : "Send"}
          aria-label="Send"
          className="m-1.5 rounded-lg bg-ember-400 p-2 text-ink-950 transition-opacity hover:bg-ember-300 disabled:opacity-25"
        >
          {waitingToSend ? <LoaderCircle className="h-5 w-5 animate-spin" /> : returnSends ? <CornerDownLeft className="h-4 w-4" /> : <ArrowUp className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
});

function Thumb({ a, onRemove }: { a: Attachment; onRemove(): void }) {
  const kb = a.size < 1024 * 1024 ? `${Math.max(1, Math.round(a.size / 1024))} KB` : `${(a.size / 1024 / 1024).toFixed(1)} MB`;
  const status = a.error ? `Couldn't save it on the machine: ${a.error}` : a.path ? `Saved on the machine as ${a.path}` : "Saving on the machine…";
  return (
    <div
      className={`group relative h-12 shrink-0 overflow-hidden rounded-lg ring-1 ${a.error ? "ring-rose-400/70" : "ring-ink-600"}`}
      title={`Image, ${kb}. ${status}`}
    >
      <img src={a.url} alt="Pasted image" className={`h-full w-auto max-w-40 object-cover ${a.path ? "" : "opacity-50"}`} />
      {!a.path && (
        <div className="absolute inset-0 flex items-center justify-center">
          {a.error ? <TriangleAlert className="h-4 w-4 text-rose-300" /> : <LoaderCircle className="h-4 w-4 animate-spin text-mist-200" />}
        </div>
      )}
      <button
        onClick={onRemove}
        title="Remove"
        className="absolute top-0.5 right-0.5 rounded-md bg-ink-950/80 p-0.5 text-mist-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-mist-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export default Composer;
