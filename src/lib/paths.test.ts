import { describe, expect, it } from "vitest";

import { baseName, crumbsOf, driveOf, freeName, homeCrumbs, isRoot, isWithin, joinPath, parentPath, resolveTyped, sameFolder, typedPath } from "./paths";

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

describe("phone paths", () => {
  it("shows home as one crumb", () => {
    expect(homeCrumbs("/home/u/code/app", "/home/u")).toEqual([
      { label: "~", path: "/home/u" },
      { label: "code", path: "/home/u/code" },
      { label: "app", path: "/home/u/code/app" },
    ]);
    expect(homeCrumbs("/home/u", "/home/u")).toEqual([{ label: "~", path: "/home/u" }]);
    expect(homeCrumbs("/etc/nginx", "/home/u")).toEqual([
      { label: "/", path: "/" },
      { label: "etc", path: "/etc" },
      { label: "nginx", path: "/etc/nginx" },
    ]);
    expect(homeCrumbs("/home/user2", "/home/u").map((c) => c.label)).toEqual(["/", "home", "user2"]);
    expect(homeCrumbs("D:/a", "C:/Users/me").map((c) => c.label)).toEqual(["D:", "a"]);
  });

  it("types from where you are", () => {
    expect(typedPath("/home/u/code", "/home/u")).toBe("~/code/");
    expect(typedPath("/home/u", "/home/u")).toBe("~/");
    expect(typedPath("/", "/home/u")).toBe("/");
    expect(resolveTyped("~/code/", "/x")).toBe("~/code/");
    expect(resolveTyped("src/lib", "/home/u/app")).toBe("/home/u/app/src/lib");
    expect(resolveTyped("..", "/home/u/app")).toBe("/home/u/app/..");
    expect(resolveTyped("/etc", "/home/u")).toBe("/etc");
    expect(resolveTyped("D:/games", "C:/")).toBe("D:/games");
    expect(resolveTyped("  ", "/home/u")).toBeNull();
  });
});

describe("freeName", () => {
  it("numbers a taken name like uploads do", () => {
    expect(freeName("a.txt", new Set())).toBe("a.txt");
    expect(freeName("a.txt", new Set(["a.txt", "a (1).txt"]))).toBe("a (2).txt");
    expect(freeName("src", new Set(["src"]))).toBe("src (1)");
    expect(freeName(".env", new Set([".env"]))).toBe(".env (1)");
  });
});
