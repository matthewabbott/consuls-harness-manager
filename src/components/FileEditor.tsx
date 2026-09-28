import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
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
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { theme as palette } from "../term/palette";
import { backend } from "../ipc/backend";
import { gitGutter, setHead } from "../editor/gitGutter";
import { buffers, useEditor } from "../store/editor";
import { useFiles } from "../store/files";

const MONO = `"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace`;

const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: palette.background, color: palette.foreground, fontSize: "13px" },
    ".cm-scroller": { fontFamily: MONO, lineHeight: "1.5" },
    ".cm-content": { caretColor: palette.cursor, padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.cursor, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(106,169,255,0.28) !important" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.035)" },
    ".cm-gutters": { backgroundColor: palette.background, color: "#4b5468", border: "none", paddingRight: "4px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#9aa4ba" },
    ".cm-foldPlaceholder": { backgroundColor: "#1c2130", border: "none", color: "#9aa4ba" },
    ".cm-selectionMatch": { backgroundColor: "rgba(229,192,123,0.16)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(106,169,255,0.22)", outline: "none" },
    ".cm-searchMatch": { backgroundColor: "rgba(229,192,123,0.25)", outline: "1px solid rgba(229,192,123,0.5)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(245,162,93,0.45)" },
    ".cm-panels": { backgroundColor: "#151925", color: palette.foreground, borderTop: "1px solid #252b3b" },
    ".cm-panels input, .cm-panels button": { fontFamily: "inherit", fontSize: "12px" },
    ".cm-textfield": { backgroundColor: "#0e1119", border: "1px solid #2d3447", color: palette.foreground, borderRadius: "4px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "#232a3a", border: "1px solid #2d3447", color: palette.foreground, borderRadius: "4px" },
    ".cm-tooltip": { backgroundColor: "#151925", border: "1px solid #2d3447" },
  },
  { dark: true },
);

const a = palette.ansi;
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: a[5] },
  { tag: [t.string, t.special(t.string), t.regexp], color: a[2] },
  { tag: [t.number, t.bool, t.null, t.atom], color: a[3] },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6b7590", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: a[4] },
  { tag: [t.typeName, t.className, t.namespace], color: a[6] },
  { tag: [t.definition(t.variableName)], color: a[15] },
  { tag: [t.propertyName], color: "#9ab8ff" },
  { tag: [t.tagName], color: a[1] },
  { tag: [t.attributeName], color: a[3] },
  { tag: [t.heading], color: a[12], fontWeight: "bold" },
  { tag: [t.link, t.url], color: a[4], textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.meta, t.processingInstruction], color: a[8] },
  { tag: [t.invalid], color: a[9] },
]);

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
