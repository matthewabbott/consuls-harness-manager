import { describe, expect, it } from "vitest";

import { isPrefix, nextPaneTarget, prefixAction, prefixLabel, windowTarget } from "./tmuxPrefix";

describe("tmux prefix keys", () => {
  it("map the stock bindings", () => {
    expect(prefixAction("d", null, "C-b")).toEqual({ kind: "grid" });
    expect(prefixAction("%", null, "C-b")).toEqual({ kind: "split", horizontal: true });
    expect(prefixAction('"', null, "C-b")).toEqual({ kind: "split", horizontal: false });
    expect(prefixAction("3", null, "C-b")).toEqual({ kind: "window", which: 3 });
    expect(prefixAction("$", null, "C-b")).toEqual({ kind: "rename", what: "session" });
    expect(prefixAction("b", "C-b", "C-b")).toEqual({ kind: "sendPrefix" });
    expect(prefixAction("q", null, "C-b")).toEqual({ kind: "unknown" });
  });

  it("recognise the server's prefix", () => {
    expect(isPrefix("b", "C-b", "C-b")).toBe(true);
    expect(isPrefix("a", "C-a", "C-b")).toBe(false);
    expect(isPrefix("`", null, "`")).toBe(true);
    expect(prefixLabel("C-b")).toBe("Ctrl+B");
    expect(prefixLabel("M-a")).toBe("Alt+A");
  });

  it("find other windows' panes", () => {
    const p = (key: number, windowIndex: number, paneIndex = 0, paneActive = true) => ({ key, windowIndex, paneIndex, paneActive });
    const panes = [p(1, 0), p(2, 1, 0, false), p(3, 1, 1, true), p(4, 3)];
    expect(windowTarget(panes, panes[0], "next")).toBe(3); // window 1's active pane
    expect(windowTarget(panes, panes[0], "prev")).toBe(4); // wraps to window 3
    expect(windowTarget(panes, panes[0], 3)).toBe(4);
    expect(windowTarget(panes, panes[0], 2)).toBe(null);
    expect(nextPaneTarget(panes, panes[1])).toBe(3);
    expect(nextPaneTarget(panes, panes[0])).toBe(null);
  });
});
