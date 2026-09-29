import { describe, expect, it } from "vitest";
import { smartCopy, type Row } from "./smartCopy";

const rows = (...lines: string[]): Row[] => lines.map((text) => ({ text, wrapped: false }));
const COLS = 60;

describe("smartCopy", () => {
  it("joins Claude-style hard-wrapped paragraphs and strips the gutter", () => {
    const text = smartCopy(
      rows(
        "⏺ Reconnects now re-attach and re-seed every pane; the live  ",
        "  test passes 8 consecutive seeds under load with no",
        "  divergence.",
      ),
      COLS,
    );
    expect(text).toBe("Reconnects now re-attach and re-seed every pane; the live test passes 8 consecutive seeds under load with no divergence.");
  });

  it("joins a hard-wrapped URL without spaces (Claude Code's sign-in link)", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc";
    const chunks = url.match(/.{1,56}/g)!;
    const text = smartCopy(rows("  Browser didn't open? Use the url below to sign in", "", ...chunks.map((c) => `  ${c}`)), COLS);
    expect(text).toBe(`Browser didn't open? Use the url below to sign in\n\n${url}`);
  });

  it("keeps short lines, blank lines and list items separate", () => {
    const text = smartCopy(
      rows("⏺ Corrected final status:", "", "  - Criterion 1: not met as written, both arms scored", "  - Criteria 2–4: met"),
      COLS,
    );
    expect(text).toBe("Corrected final status:\n\n- Criterion 1: not met as written, both arms scored\n- Criteria 2–4: met");
  });

  it("joins terminal soft wraps regardless of heuristics", () => {
    const text = smartCopy(
      [
        { text: "consulear@spark2:~$ echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", wrapped: false },
        { text: "bbbb", wrapped: true },
      ],
      COLS,
    );
    expect(text).toBe("consulear@spark2:~$ echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb");
  });

  it("never joins inside code fences", () => {
    const long = "  const cellW = width / Math.max(snap.cols, 1); // a long line";
    const text = smartCopy(rows("  ```ts", long, "  const next = 1;", "  ```"), COLS);
    expect(text).toBe("```ts\n" + long.trim() + "\nconst next = 1;\n```");
  });

  it("strips Codex bullets", () => {
    const text = smartCopy(rows("• Edited src/term/tilePainter.ts (+84 -0)"), COLS);
    expect(text).toBe("Edited src/term/tilePainter.ts (+84 -0)");
  });

  it("dedents plain selections", () => {
    expect(smartCopy(rows("    a", "      b"), COLS)).toBe("a\n  b");
  });
});
