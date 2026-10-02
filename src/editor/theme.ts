// The code view's look, shared by the desktop editor and the phone's file viewer.

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { theme as palette } from "../term/palette";

const MONO = `"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace`;

export const editorTheme = EditorView.theme(
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
export const highlight = HighlightStyle.define([
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
