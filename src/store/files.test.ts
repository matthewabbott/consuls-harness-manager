import { describe, expect, it } from "vitest";

import { badgesFor, statusOf } from "./files";

describe("git badges", () => {
  const git = {
    root: "/r",
    branch: "main",
    entries: [
      { path: "src/a.ts", status: "modified" as const },
      { path: "src/deep/new.ts", status: "untracked" as const },
      { path: "docs/x.md", status: "added" as const },
      { path: "target/", status: "ignored" as const },
    ],
  };

  it("rolls the loudest status up to folders, but not ignored", () => {
    const b = badgesFor(git);
    expect(b["/r/src/a.ts"]).toBe("modified");
    expect(b["/r/src"]).toBe("modified");
    expect(b["/r/src/deep"]).toBe("untracked");
    expect(b["/r/docs"]).toBe("added");
    expect(b["/r/target"]).toBe("ignored");
    expect(b["/r"]).toBeUndefined();
  });

  it("marks everything under an ignored folder as ignored", () => {
    const b = badgesFor(git);
    expect(statusOf(b, "/r/target/debug/app", "/r")).toBe("ignored");
    expect(statusOf(b, "/r/README.md", "/r")).toBeUndefined();
    expect(statusOf(b, "/elsewhere", "/r")).toBeUndefined();
  });
});
