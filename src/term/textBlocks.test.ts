import { describe, expect, it } from "vitest";

import { bufferRows, splitBlocks } from "./textBlocks";

const rows = (...lines: string[]) => lines.map((text) => ({ text, wrapped: false }));
const COLS = 60;

describe("splitBlocks", () => {
  it("cuts Claude Code output into prompts, messages and tool calls", () => {
    const blocks = splitBlocks(
      rows(
        "> refactor the session supervisor so reconnects re-seed",
        "",
        "⏺ I'll start by reading the supervisor and the seed path.",
        "",
        "⏺ Read(crates/chm-core/src/hub/host.rs)",
        "  ⎿  Read 212 lines",
        "",
        "⏺ Reconnects now re-attach and re-seed every pane; the live  ",
        "  test passes 8 consecutive seeds under load.",
      ),
      COLS,
    );
    expect(blocks.map((b) => b.kind)).toEqual(["you", "agent", "tool", "agent"]);
    expect(blocks[0].text).toBe("refactor the session supervisor so reconnects re-seed");
    expect(blocks[3].text).toBe("Reconnects now re-attach and re-seed every pane; the live test passes 8 consecutive seeds under load.");
  });

  it("leaves out Claude Code's input box and status line", () => {
    const blocks = splitBlocks(
      rows(
        "⏺ Done: the build passes.",
        "",
        "╭──────────────────────────────────────╮",
        "│ >                                    │",
        "╰──────────────────────────────────────╯",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
        "⏺ A table:",
        "┌───┬───┐",
        "│ a │ b │",
        "└───┴───┘",
      ),
      COLS,
    );
    expect(blocks.map((b) => b.text)).toEqual(["Done: the build passes.", "A table:\n┌───┬───┐\n│ a │ b │\n└───┴───┘"]);
  });

  it("knows Codex's bullets", () => {
    const blocks = splitBlocks(rows("› fix the build", "", "• Ran cargo build", "  └ ok", "", "• The build passes now."), COLS);
    expect(blocks.map((b) => b.kind)).toEqual(["you", "tool", "agent"]);
  });

  it("keeps a shell's output as one block", () => {
    const blocks = splitBlocks(rows("$ ls", "a  b  c", "$ echo hi", "hi"), COLS);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("output");
  });

  it("doesn't start a block on a soft-wrapped row", () => {
    const blocks = splitBlocks([{ text: "⏺ a long line that the terminal wrapped onto", wrapped: false }, { text: "• not a bullet", wrapped: true }], COLS);
    expect(blocks).toHaveLength(1);
  });
});

describe("bufferRows", () => {
  const buffer = (lines: [string, boolean][]) => ({
    length: lines.length,
    getLine: (y: number) => (lines[y] ? { isWrapped: lines[y][1], translateToString: () => lines[y][0] } : undefined),
  });

  it("reads the last rows, never starting mid-row", () => {
    const b = buffer([
      ["one", false],
      ["two", false],
      ["two, wrapped", true],
      ["three", false],
    ]);
    expect(bufferRows(b).map((r) => r.text)).toEqual(["one", "two", "two, wrapped", "three"]);
    expect(bufferRows(b, 2).map((r) => r.text)).toEqual(["three"]);
  });
});
