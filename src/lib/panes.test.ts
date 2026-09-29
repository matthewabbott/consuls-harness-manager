import { describe, expect, it } from "vitest";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { displayTitle } from "./panes";

const pane = (extra: Partial<PaneInfo>): PaneInfo => ({
  key: 1,
  host: "spark2",
  kind: "tmux",
  tmux: {
    paneId: "%1",
    windowId: "@1",
    sessionId: "$1",
    sessionName: "work",
    sessionGroup: null,
    windowIndex: 1,
    windowName: "codex",
    paneIndex: 0,
    dead: false,
    windowActive: true,
    paneActive: true,
    windowPanes: 1,
    sized: false,
    prefix: "C-b",
  },
  width: 80,
  height: 24,
  currentCommand: "codex",
  currentPath: "/home/u/proj",
  title: "",
  name: null,
  harness: "codex",
  alternateOn: false,
  chmId: null,
  hidden: false,
  labels: [],
  ended: null,
  bell: null,
  bellPings: false,
  notify: null,
  seen: null,
  ...extra,
});

describe("displayTitle", () => {
  it("prefers the name, then a real title", () => {
    expect(displayTitle(pane({ name: "PR #12", title: "✳ Refactor" }))).toBe("PR #12");
    expect(displayTitle(pane({ title: "✳ Refactor supervisor" }))).toBe("Refactor supervisor");
  });

  it("skips titles that are just the machine", () => {
    // tmux's default pane title is the hostname: `spark2`, or `MBAs-MacBook-Pro.local` on macOS.
    expect(displayTitle(pane({ title: "spark2" }))).toBe("codex");
    expect(displayTitle(pane({ host: "@local", title: "MBAs-MacBook-Pro.local" }))).toBe("codex");
    expect(displayTitle(pane({ title: "consulear@spark2:~/proj" }))).toBe("codex");
  });
});
