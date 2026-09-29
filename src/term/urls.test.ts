import { describe, expect, it } from "vitest";

import { continuesUrl, findUrls } from "./urls";

const COLS = 40;
const pad = (s: string) => s.padEnd(COLS);
const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz";

/** `text` hard-wrapped the way an Ink box does: `indent` spaces, then chunks to the edge. */
function wrapped(text: string, indent = 2) {
  const width = COLS - indent;
  const rows = [];
  for (let i = 0; i < text.length; i += width) rows.push({ text: pad(" ".repeat(indent) + text.slice(i, i + width)), wrapped: false });
  return rows;
}

describe("hard-wrapped URLs", () => {
  it("are found whole, across rows", () => {
    const rows = [{ text: pad("  Browser didn't open? Use the url below"), wrapped: false }, { text: pad(""), wrapped: false }, ...wrapped(url)];
    const found = findUrls(rows, COLS);
    expect(found.map((u) => u.url)).toEqual([url]);
    expect(found[0].start).toEqual({ row: 2, col: 2 });
    expect(found[0].end.row).toBe(rows.length - 1);
  });

  it("follow terminal soft wraps too", () => {
    const rows = [
      { text: url.slice(0, COLS), wrapped: false },
      { text: pad(url.slice(COLS)), wrapped: true },
    ];
    expect(findUrls(rows, COLS).map((u) => u.url)).toEqual([url]);
  });

  it("don't swallow prose after a URL that ends at the edge", () => {
    const line = "see https://example.com/some/long/path/x";
    expect(line.length).toBe(COLS);
    expect(continuesUrl(line, line, "and then it works", COLS)).toBe(false);
    expect(continuesUrl(line, line, "/more/path", COLS)).toBe(true);
    expect(continuesUrl(line, line, "  abcdefghijklmnopqrstuvwxyzABCDEF", COLS)).toBe(true); // a long bare token
    expect(continuesUrl(line, line, "Done", COLS)).toBe(false);
    expect(continuesUrl("short https://a.b/c", "short https://a.b/c", "/more", COLS)).toBe(false);
    const rows = [{ text: line, wrapped: false }, { text: pad("and then it works"), wrapped: false }];
    expect(findUrls(rows, COLS).map((u) => u.url)).toEqual(["https://example.com/some/long/path/x"]);
  });
});
