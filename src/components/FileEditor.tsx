import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Text } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { editorTheme, highlight } from "../editor/theme";
import { backend } from "../ipc/backend";
import { gitGutter, setHead } from "../editor/gitGutter";
import { redaction } from "../editor/redaction";
import { buffers, useEditor } from "../store/editor";
import { useFiles } from "../store/files";

/** One language slot per file, so a remounted editor can still receive its language. */
const languageSlots = new Map<string, Compartment>();

export interface FileEditorHandle {
  focus(): void;
  view(): EditorView | null;
}

interface Props {
  id: string;
  onCursor?(line: number, col: number): void;
  onLanguage?(name: string | null): void;
}

/** Text editor for one open file. Its state lives in `buffers` while it's off screen. */
const FileEditor = forwardRef<FileEditorHandle, Props>(function FileEditor({ id, onCursor, onLanguage }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cb = useRef({ onCursor, onLanguage });
  cb.current = { onCursor, onLanguage };

  useImperativeHandle(ref, () => ({ focus: () => viewRef.current?.focus(), view: () => viewRef.current }));

  useEffect(() => {
    const buf = buffers.get(id);
    const file = useEditor.getState().files[id];
    if (!buf || !file || !hostRef.current) return;
    const language = languageSlots.get(id) ?? new Compartment();
    languageSlots.set(id, language);
    const save = () => {
      void useEditor.getState().save(id);
      return true;
    };
    const state =
      buf.state ??
      EditorState.create({
        doc: buf.initial,
        extensions: [
          gitGutter(),
          redaction,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(highlight, { fallback: true }),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([{ key: "Mod-s", run: save, preventDefault: true }, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          language.of([]),
          editorTheme,
        ],
      });
    const view = new EditorView({
      state,
      parent: hostRef.current,
      dispatch: (tr, v) => {
        v.update([tr]);
        const b = buffers.get(id);
        if (b) b.state = v.state;
        if (tr.docChanged) useEditor.getState().edited(id, v.state.doc);
        if (tr.selection || tr.docChanged) {
          const head = v.state.selection.main.head;
          const line = v.state.doc.lineAt(head);
          cb.current.onCursor?.(line.number, head - line.from + 1);
        }
      },
    });
    viewRef.current = view;
    buf.state = view.state;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    cb.current.onCursor?.(line.number, head - line.from + 1);

    // Syntax highlighting for the file's language, loaded on demand.
    const desc = LanguageDescription.matchFilename(languages, file.name);
    cb.current.onLanguage?.(desc?.name ?? null);
    let cancelled = false;
    const current = language.get(view.state);
    if (desc && (!current || (Array.isArray(current) && current.length === 0))) {
      void desc.load().then((support) => {
        if (!cancelled) view.dispatch({ effects: language.reconfigure(support) });
      });
    }
    // Jump to a requested line (terminal links), now and whenever another one arrives.
    const goTo = () => {
      const g = useEditor.getState().files[id]?.goto;
      if (!g) return;
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(g.line, 1), doc.lines));
      const pos = Math.min(line.from + Math.max(g.col - 1, 0), line.to);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      useEditor.getState().wentTo(id);
    };
    goTo();
    const unsubGoto = useEditor.subscribe((s, prev) => {
      if (s.files[id]?.goto && s.files[id]?.goto !== prev.files[id]?.goto) goTo();
    });

    // The committed version, for the change gutter; refreshed when git status for this file
    // changes (e.g. after a commit in a pane) or the window regains focus.
    const loadHead = () =>
      void backend()
        .then((b) => b.gitHead(file.host, file.path))
        .then((v) => {
          if (cancelled) return;
          const head = v.kind === "text" ? Text.of(v.text.replace(/\r\n?/g, "\n").split("\n")) : v.kind === "untracked" ? "untracked" : null;
          view.dispatch({ effects: setHead.of(head) });
        })
        .catch(() => undefined);
    loadHead();
    window.addEventListener("focus", loadHead);
    const unsubGit = useFiles.subscribe((s, prev) => {
      if (s.badges[file.path] !== prev.badges[file.path]) loadHead();
    });

    view.focus();
    return () => {
      window.removeEventListener("focus", loadHead);
      unsubGit();
      unsubGoto();
      cancelled = true;
      const b = buffers.get(id);
      if (b) b.state = view.state;
      view.destroy();
      viewRef.current = null;
    };
  }, [id]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
});

export default FileEditor;
