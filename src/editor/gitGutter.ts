// Git change markers in the editor gutter: lines added, modified or deleted relative to the
// file's committed (HEAD) version, like VS Code's.

import { Chunk } from "@codemirror/merge";
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** The committed text, "untracked" (all lines are new), or null (no gutter). */
export type Head = Text | "untracked" | null;

export const setHead = StateEffect.define<Head>();
const setMarkers = StateEffect.define<RangeSet<GutterMarker>>();

/** Above this the gutter is off (diffing on every pause would get slow). */
export const GUTTER_LIMIT = 1024 * 1024;

type Kind = "added" | "modified" | "deleted";

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: Kind) {
    super();
  }
  eq(other: ChangeMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git-${this.kind}`;
    el.title = this.kind === "added" ? "Added since the last commit" : this.kind === "modified" ? "Changed since the last commit" : "Lines deleted here";
    return el;
  }
}

const MARK: Record<Kind, ChangeMarker> = { added: new ChangeMarker("added"), modified: new ChangeMarker("modified"), deleted: new ChangeMarker("deleted") };

const headField = StateField.define<Head>({
  create: () => null,
  update: (value, tr) => tr.effects.reduce<Head>((v, e) => (e.is(setHead) ? e.value : v), value),
});

const markersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

/** Markers for `state` (pure; exported for tests). */
export function computeMarkers(state: EditorState): RangeSet<GutterMarker> {
  const head = state.field(headField, false) ?? null;
  const doc = state.doc;
  if (!head || doc.length > GUTTER_LIMIT) return RangeSet.empty;
  const builder = new RangeSetBuilder<GutterMarker>();
  if (head === "untracked") {
    for (let n = 1; n <= doc.lines; n++) builder.add(doc.line(n).from, doc.line(n).from, MARK.added);
    return builder.finish();
  }
  for (const chunk of Chunk.build(head, doc)) {
    if (chunk.fromB === chunk.toB) {
      // Deleted lines: mark the line they were above.
      const at = doc.lineAt(Math.min(chunk.fromB, doc.length));
      builder.add(at.from, at.from, MARK.deleted);
      continue;
    }
    // Nothing on the committed side (or only the empty "line" after its final newline, which
    // git doesn't count): new lines.
    const kind: Kind = chunk.fromA === chunk.toA || chunk.fromA >= head.length ? "added" : "modified";
    const first = doc.lineAt(chunk.fromB).number;
    const last = doc.lineAt(Math.min(chunk.endB, doc.length)).number;
    for (let n = first; n <= last; n++) builder.add(doc.line(n).from, doc.line(n).from, MARK[kind]);
  }
  return builder.finish();
}

/** Recomputes shortly after the text or the HEAD version changes. */
const refresher = ViewPlugin.fromClass(
  class {
    timer = 0;
    constructor(readonly view: EditorView) {
      this.schedule(0);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setHead)))) this.schedule(250);
    }
    schedule(ms: number) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        const markers = computeMarkers(this.view.state);
        this.view.dispatch({ effects: setMarkers.of(markers) });
      }, ms);
    }
    destroy() {
      window.clearTimeout(this.timer);
    }
  },
);

const theme = EditorView.theme({
  ".cm-git-gutter": { width: "4px", marginRight: "2px" },
  ".cm-git-gutter .cm-gutterElement": { padding: "0" },
  ".cm-git-added": { height: "100%", borderLeft: "3px solid #7fd4a0" },
  ".cm-git-modified": { height: "100%", borderLeft: "3px solid #6aa9ff" },
  ".cm-git-deleted": {
    height: "0",
    width: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid #f07178",
    transform: "translateY(-4px)",
  },
});

export function gitGutter(): Extension {
  return [
    headField,
    markersField,
    refresher,
    gutter({ class: "cm-git-gutter", markers: (v) => v.state.field(markersField) }),
    theme,
  ];
}
