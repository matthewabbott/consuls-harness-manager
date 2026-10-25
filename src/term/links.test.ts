import { describe, expect, it } from "vitest";

import { continuesPath, findPathSpans, findPaths, normalizePath, resolvePath } from "./links";

const paths = (s: string) => findPaths(s).map((r) => [r.path, r.line ?? null, r.col ?? null, s.slice(r.index, r.index + r.length)]);

describe("terminal file links", () => {
  it("finds paths with line and column", () => {
    expect(paths("error at src/App.tsx:42:7 here")).toEqual([["src/App.tsx", 42, 7, "src/App.tsx:42:7"]]);
    expect(paths("  --> crates/chm-core/src/lib.rs:10:5")).toEqual([["crates/chm-core/src/lib.rs", 10, 5, "crates/chm-core/src/lib.rs:10:5"]]);
    expect(paths('File "./tools/run.py", line 3')).toEqual([["./tools/run.py", null, null, "./tools/run.py"]]);
    expect(paths(String.raw`C:\code\main.cs(12,5): error`)).toEqual([[String.raw`C:\code\main.cs`, 12, 5, String.raw`C:\code\main.cs(12,5)`]]);
    expect(paths("Updated README.md.")).toEqual([["README.md", null, null, "README.md"]]);
  });

  it("skips things that aren't file references", () => {
    expect(paths("e.g. v1.2.3 and 3.14")).toEqual([]);
    expect(paths("see https://github.com/a/b/blob/main/x.ts for more")).toEqual([]);
    expect(paths("user@host.name")).toEqual([]);
  });

  it("resolves against the working directory", () => {
    expect(resolvePath("src/App.tsx", "/home/u/proj")).toBe("/home/u/proj/src/App.tsx");
    expect(resolvePath("../lib/x.rs", "/home/u/proj/app")).toBe("/home/u/proj/lib/x.rs");
    expect(resolvePath("/etc/hosts.conf", "/tmp")).toBe("/etc/hosts.conf");
    expect(resolvePath("~/notes.md", "/tmp", "/home/u")).toBe("/home/u/notes.md");
    expect(resolvePath(String.raw`src\main.rs`, "C:/code/proj")).toBe("C:/code/proj/src/main.rs");
    expect(normalizePath("C:/a/./b/../c")).toBe("C:/a/c");
  });

  it("finds paths wrapped onto the next row", () => {
    const cols = 30;
    const row = (text: string, wrapped = false) => ({ text: text.padEnd(cols), wrapped });
    // Hard-wrapped by the program at the right edge.
    const spans = findPathSpans([row("Edited src/components/compose"), row("r/Composer.tsx:42 to fix it")], cols);
    expect(spans.map((s) => [s.path, s.line, s.start, s.end])).toEqual([["src/components/composer/Composer.tsx", 42, { row: 0, col: 7 }, { row: 1, col: 16 }]]);
    // Soft-wrapped by the terminal.
    expect(findPathSpans([{ text: "see lib/x/", wrapped: false }, { text: "y.ts      ", wrapped: true }], 10).map((s) => s.path)).toEqual(["lib/x/y.ts"]);
    // A row that stops short of the edge, or prose after a path at the edge, isn't glued.
    expect(findPathSpans([{ text: "src/a.ts", wrapped: false }, row("b.ts")], cols).map((s) => s.path)).toEqual(["src/a.ts", "b.ts"]);
    expect(continuesPath("see the file at src/app/main.ts".padEnd(30).trimEnd(), "and then run it", 30)).toBe(false);
  });
});

