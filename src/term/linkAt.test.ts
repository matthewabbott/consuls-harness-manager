import { describe, expect, it } from "vitest";

import { linkAt } from "./linkAt";

const buffer = (...lines: (string | [string, boolean])[]) => {
  const rows = lines.map((l) => (typeof l === "string" ? ([l, false] as [string, boolean]) : l));
  return {
    length: rows.length,
    getLine: (y: number) => (rows[y] ? { isWrapped: rows[y][1], translateToString: () => rows[y][0] } : undefined),
  };
};

describe("linkAt", () => {
  it("finds the URL under the tap, across a wrap", () => {
    const b = buffer(["See https://example.com/a/very/long/pa", false], ["th/to/a/page for details", true]);
    expect(linkAt(b, 38, 10, 0)).toEqual({ kind: "url", url: "https://example.com/a/very/long/path/to/a/page" });
    expect(linkAt(b, 38, 3, 1)).toEqual({ kind: "url", url: "https://example.com/a/very/long/path/to/a/page" });
    expect(linkAt(b, 38, 1, 0)).toBeNull();
  });

  it("finds a file reference with its line", () => {
    const b = buffer("error in src/App.tsx:42:7 near here");
    expect(linkAt(b, 80, 12, 0)).toEqual({ kind: "path", path: "src/App.tsx", line: 42, col: 7 });
    expect(linkAt(b, 80, 30, 0)).toBeNull();
  });

  it("is nothing outside the buffer", () => {
    expect(linkAt(buffer("x"), 80, 0, 5)).toBeNull();
  });
});
