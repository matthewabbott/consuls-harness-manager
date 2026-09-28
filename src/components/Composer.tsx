import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { CornerDownLeft } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { getDraft, getHistory, paneIdentity, pushHistory, setDraft } from "../store/composer";
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
  },
  { dark: true },
);

interface Props {
  pane: PaneInfo;
  /** Called when the user presses Escape in an empty composer (interrupt the agent). */
  onEscapeEmpty(): void;
}

const Composer = forwardRef<ComposerHandle, Props>(function Composer({ pane, onEscapeEmpty }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [focused, setFocused] = useState(false);
  const [empty, setEmpty] = useState(true);
  const id = paneIdentity(pane);
  const key = pane.key;

  useImperativeHandle(ref, () => ({ focus: () => viewRef.current?.focus() }));

  useEffect(() => {
    // Prompt history navigation: -1 = the live draft.
    let histIndex = -1;
    let liveDraft = "";

    const replace = (view: EditorView, text: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
    };

    const send = (view: EditorView): boolean => {
      const text = view.state.doc.toString();
      if (!text.trim()) return true;
      backend().then((b) => b.submitPrompt(key, text));
      pushHistory(id, text);
      histIndex = -1;
      replace(view, "");
      return true;
    };

    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: getDraft(id),
        extensions: [
          history(),
          EditorView.lineWrapping,
          placeholder(`Message ${harnessLabel(pane.harness)}…  (Enter to send · Shift+Enter for a new line)`),
          theme,
          Prec.highest(
            keymap.of([
              { key: "Enter", run: send },
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
          }),
        ],
      }),
    });
    viewRef.current = view;
    setEmpty(view.state.doc.length === 0);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);

  const sendClick = () => {
    const v = viewRef.current;
    if (!v) return;
    const text = v.state.doc.toString();
    if (!text.trim()) return;
    backend().then((b) => b.submitPrompt(key, text));
    pushHistory(id, text);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } });
    v.focus();
  };

  return (
    <div
      className={`flex h-full items-end rounded-xl bg-ink-850 ring-1 transition-shadow ${
        focused ? "shadow-[0_0_0_3px_rgb(245_162_93/0.12)] ring-ember-400/50" : "ring-ink-700"
      }`}
    >
      <div ref={hostRef} className="h-full min-w-0 flex-1 cursor-text" onMouseDown={() => setTimeout(() => viewRef.current?.focus(), 0)} />
      <button
        onClick={sendClick}
        disabled={empty}
        title="Send (Enter)"
        className="m-1.5 rounded-lg bg-ember-400 p-2 text-ink-950 transition-opacity hover:bg-ember-300 disabled:opacity-25"
      >
        <CornerDownLeft className="h-4 w-4" />
      </button>
    </div>
  );
});

export default Composer;
