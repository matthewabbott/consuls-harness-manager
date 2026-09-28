import { describe, expect, it } from "vitest";

import { findPaths, normalizePath, resolvePath } from "./links";

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
});
