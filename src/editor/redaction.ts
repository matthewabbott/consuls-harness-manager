// Recording mode in the editor: personal strings in the visible lines are drawn as masks
// (replace decorations), without touching the document.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import { maskOf } from "../lib/redact";
import { useRecording } from "../store/recording";

class Mask extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: Mask) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    return span;
  }
}

function build(view: EditorView): DecorationSet {
  const r = useRecording.getState().tile;
  if (!r) return Decoration.none;
  const out = new RangeSetBuilder<Decoration>();
  let next = 0; // first position not yet scanned (visible ranges can share a line)
  for (const { from, to } of view.visibleRanges) {
    for (let pos = Math.max(from, next); pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const [a, b] of r.spans(line.text)) {
        out.add(line.from + a, line.from + b, Decoration.replace({ widget: new Mask(maskOf(line.text.slice(a, b))) }));
      }
      pos = next = line.to + 1;
    }
  }
  return out.finish();
}

export const redaction = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private unsubscribe: () => void;
    constructor(view: EditorView) {
      this.decorations = build(view);
      let last = useRecording.getState().tile;
      this.unsubscribe = useRecording.subscribe((s) => {
        if (s.tile === last) return;
        last = s.tile;
        this.decorations = build(view);
        view.dispatch({}); // redraw with the new decorations
      });
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
    destroy() {
      this.unsubscribe();
    }
  },
  { decorations: (v) => v.decorations },
);
