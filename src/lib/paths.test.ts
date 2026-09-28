import { describe, expect, it } from "vitest";

import { baseName, crumbsOf, driveOf, isRoot, isWithin, joinPath, parentPath, sameFolder } from "./paths";

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

  it("compares folders for the places bar", () => {
    expect(driveOf("d:/a/programming")).toBe("D:");
    expect(driveOf("/home/u")).toBe(null);
    expect(sameFolder("D:/a/Programming", "d:/a/programming/")).toBe(true);
    expect(sameFolder("D:/", "D:")).toBe(true);
    expect(sameFolder("/home/U", "/home/u")).toBe(false);
    expect(isWithin("D:/a/programming/x", "D:/")).toBe(true);
    expect(isWithin("D:/a/programming", "d:/a/programming")).toBe(true);
    expect(isWithin("D:/a/programmingx", "D:/a/programming")).toBe(false);
    expect(isWithin("C:/Users", "D:/")).toBe(false);
    expect(isWithin("/home/u", "/")).toBe(true);
    expect(baseName("D:/a/programming")).toBe("programming");
    expect(baseName("D:/")).toBe("D:");
    expect(baseName("/")).toBe("/");
  });
});
