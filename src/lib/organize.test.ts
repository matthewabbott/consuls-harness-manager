import { describe, expect, it } from "vitest";

import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { groupPanes, sortPanes } from "./organize";

const pane = (key: number, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  key,
  host: "h",
  kind: "tmux",
  tmux: {
    paneId: `%${key}`,
    windowId: "@1",
    sessionId: "$1",
    sessionName: "s",
    sessionGroup: null,
    windowIndex: 1,
    windowName: `w${key}`,
    paneIndex: 1,
    dead: false,
    windowActive: true,
    paneActive: true,
    windowPanes: 1,
    sized: false,
  },
  width: 80,
  height: 24,
  currentCommand: "bash",
  currentPath: "/home/u/proj",
  title: "",
  harness: "shell",
  alternateOn: false,
  chmId: null,
  hidden: false,
  labels: [],
  ended: null,
  bell: null,
  bellPings: false,
  ...extra,
});

const att = (key: number, attention: PaneAttention["attention"], activity: PaneAttention["activity"]): PaneAttention => ({
  key,
  attention,
  activity,
  reason: null,
  since: 0,
  pulse: 0,
  source: "hook",
});

describe("organize", () => {
  it("label grouping shows a pane under each of its labels, then unlabeled", () => {
    const labels = [
      { id: "a", name: "Alpha", color: "#fff" },
      { id: "b", name: "Beta", color: "#000" },
    ];
    const groups = groupPanes([pane(1, { labels: ["a", "b"] }), pane(2, { labels: ["b"] }), pane(3)], "label", labels, {});
    expect(groups.map((g) => [g.title, g.panes.map((p) => p.key)])).toEqual([
      ["Alpha", [1]],
      ["Beta", [1, 2]],
      ["Unlabeled", [3]],
    ]);
  });

  it("attention-first sort puts unseen needs-input first, working after waiting", () => {
    const attention = { 1: att(1, "none", "working"), 2: att(2, "unacked", "idle"), 3: att(3, "unacked", "needsInput"), 4: att(4, "acked", "idle") };
    const sorted = sortPanes([pane(1), pane(2), pane(3), pane(4), pane(5)], "attention", (p) => p.tmux!.windowName, attention, {}, (p) => String(p.key));
    expect(sorted.map((p) => p.key)).toEqual([3, 2, 4, 1, 5]);
  });

  it("project grouping uses the cwd's last component", () => {
    const groups = groupPanes([pane(1, { currentPath: "/x/api" }), pane(2, { currentPath: "/y/web" }), pane(3, { currentPath: "/z/api" })], "project", [], {});
    expect(groups.map((g) => [g.title, g.panes.length])).toEqual([
      ["api", 2],
      ["web", 1],
    ]);
  });
});
