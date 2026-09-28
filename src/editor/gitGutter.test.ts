import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { computeMarkers, gitGutter, GUTTER_LIMIT, setHead } from "./gitGutter";

function marks(head: string | "untracked", now: string): string[] {
  let state = EditorState.create({ doc: now, extensions: gitGutter() });
  state = state.update({ effects: setHead.of(head === "untracked" ? "untracked" : Text.of(head.split("\n"))) }).state;
  const out: string[] = [];
  computeMarkers(state).between(0, state.doc.length, (from, _to, m) => {
    out.push(`${state.doc.lineAt(from).number}:${(m as unknown as { kind: string }).kind}`);
  });
  return out;
}

describe("git gutter", () => {
  it("marks added, modified and deleted lines like git diff", () => {
    // Files end with a newline, as real ones do (otherwise appending also changes the last line).
    const lines = (...l: string[]) => l.join("\n") + "\n";
    const head = lines("a", "b", "c", "d", "e");
    expect(marks(head, lines("a", "B", "c", "new", "e"))).toEqual(["2:modified", "4:modified"]);
    expect(marks(head, lines("a", "b", "c", "d", "e", "f"))).toEqual(["6:added"]);
    expect(marks(head, lines("a", "b", "x", "c", "d", "e"))).toEqual(["3:added"]);
    expect(marks(head, lines("a", "b", "e"))).toEqual(["3:deleted"]);
    // Typing on the empty last line (no trailing newline yet) is still an added line.
    expect(marks(head, lines("a", "b", "c", "d", "e") + "f")).toEqual(["6:added"]);
    expect(marks(head, head)).toEqual([]);
  });

  it("shows an untracked file as all added", () => {
    expect(marks("untracked", "x\ny")).toEqual(["1:added", "2:added"]);
  });

  it("turns off above 1 MB", () => {
    const big = "x".repeat(GUTTER_LIMIT + 1);
    expect(marks("untracked", big)).toEqual([]);
  });
});
