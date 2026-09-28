import { describe, expect, it } from "vitest";

import { crumbsOf, isRoot, joinPath, parentPath } from "./paths";

describe("paths", () => {
  it("walks up POSIX paths", () => {
    expect(parentPath("/home/u/proj")).toBe("/home/u");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(isRoot("/")).toBe(true);
  });

  it("walks up Windows paths to the drive root", () => {
    expect(parentPath("C:/Users/A B")).toBe("C:/Users");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBe("C:/");
    expect(isRoot("C:/")).toBe(true);
    expect(isRoot("C:/Users")).toBe(false);
  });

  it("builds breadcrumbs", () => {
    expect(crumbsOf("/home/u")).toEqual([
      { label: "home", path: "/home" },
      { label: "u", path: "/home/u" },
    ]);
    expect(crumbsOf("C:/Users/A B")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "A B", path: "C:/Users/A B" },
    ]);
    expect(joinPath("C:/", "Users")).toBe("C:/Users");
    expect(joinPath("/home/u/", "x")).toBe("/home/u/x");
  });
});
