import { describe, expect, it } from "vitest";

import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import type { SessionSummary } from "../ipc/bindings/SessionSummary";
import { ago, matchesQuery, sessionGist, sessionPane, sessionTitle } from "./recent";

const session = (extra: Partial<SessionSummary>): SessionSummary => ({
  host: "spark2",
  harness: "claude",
  id: "0b5a3f0e",
  resume: "0b5a3f0e",
  cwd: "/home/u/code/app",
  title: "Dark mode toggle",
  firstPrompt: "Add a dark mode toggle to settings",
  lastPrompt: "make it remember the choice",
  lastActive: 1_790_000_000,
  ...extra,
});

const pane = (extra: Partial<PaneInfo>): PaneInfo => ({
  key: 7,
  host: "spark2",
  kind: "tmux",
  tmux: null,
  width: 80,
  height: 24,
  currentCommand: "2.1.300",
  currentPath: "/home/u/code/app",
  title: "",
  name: null,
  harness: "claude",
  alternateOn: false,
  chmId: null,
  hidden: false,
  labels: [],
  ended: null,
  bell: null,
  bellPings: false,
  notify: null,
  seen: null,
  session: "0b5a3f0e",
  ...extra,
});

describe("titles and gists", () => {
  it("falls back from the harness's title to the prompts", () => {
    expect(sessionTitle(session({}))).toBe("Dark mode toggle");
    expect(sessionTitle(session({ title: null }))).toBe("Add a dark mode toggle to settings");
    expect(sessionTitle(session({ title: null, firstPrompt: null }))).toBe("make it remember the choice");
    expect(sessionTitle(session({ title: null, firstPrompt: null, lastPrompt: null }))).toBe("Untitled session");
  });

  it("doesn't repeat the title as the gist", () => {
    expect(sessionGist(session({}))).toBe("make it remember the choice");
    expect(sessionGist(session({ title: null, lastPrompt: null }))).toBe(null);
    expect(sessionGist(session({ title: null, lastPrompt: "make it remember the choice" }))).toBe("make it remember the choice");
    expect(sessionGist(session({ lastPrompt: null }))).toBe("Add a dark mode toggle to settings");
  });
});

describe("sessionPane", () => {
  it("finds the pane the session runs in, while its agent runs", () => {
    expect(sessionPane(session({}), [pane({ key: 1, session: "other" }), pane({})])?.key).toBe(7);
    expect(sessionPane(session({}), [pane({ host: "spark-d683" })])).toBe(null);
    // The agent quit back to the shell; the pane still remembers the session.
    expect(sessionPane(session({}), [pane({ harness: "shell" })])).toBe(null);
    expect(sessionPane(session({}), [pane({ kind: "direct", ended: "Connection lost" })])).toBe(null);
  });
});

describe("matchesQuery", () => {
  it("needs every word, anywhere", () => {
    expect(matchesQuery(session({}), "", "spark2")).toBe(true);
    expect(matchesQuery(session({}), "dark REMEMBER", "spark2")).toBe(true);
    expect(matchesQuery(session({}), "code/app spark2", "spark2")).toBe(true);
    expect(matchesQuery(session({}), "dark light", "spark2")).toBe(false);
  });
});

describe("ago", () => {
  it("is brief", () => {
    const now = 1_790_000_000_000;
    expect(ago(1_790_000_000 - 30, now)).toBe("now");
    expect(ago(1_790_000_000 - 300, now)).toBe("5m");
    expect(ago(1_790_000_000 - 3 * 3600, now)).toBe("3h");
    expect(ago(1_790_000_000 - 2 * 86400, now)).toBe("2d");
    expect(ago(1_790_000_000 - 20 * 86400, now)).not.toMatch(/^\d+[mhd]$/);
  });
});
