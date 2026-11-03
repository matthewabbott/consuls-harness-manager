import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Draft } from "../lib/drafts";

const stamp = { size: 5, mtime: 1, hash: "x" };
let readFile: (host: string, path: string) => Promise<unknown>;
let saved: Draft[] = [];

vi.mock("../ipc/backend", () => ({ backend: async () => ({ readFile: (h: string, p: string) => readFile(h, p) }) }));
vi.mock("../lib/drafts", () => ({ drafts: { all: async () => saved, remove: async () => {}, put: async () => {} } }));

const { buffers, fileId, useEditor } = await import("./editor");

const id = fileId("@local", "/r/notes.txt");
const draft: Draft = { id, host: "@local", path: "/r/notes.txt", text: "hello (draft)", eol: "lf", bom: false, stamp, origin: null, savedAt: 1 };
const onDisk = { kind: "text", text: "hello", bom: false, stamp };

describe("unsaved buffers after a restart", () => {
  beforeEach(() => {
    useEditor.setState({ files: {}, order: [] });
    buffers.clear();
    readFile = async () => onDisk;
    saved = [draft];
  });

  it("go into a file the layout already opened again", async () => {
    await useEditor.getState().open("@local", "/r/notes.txt", null, undefined, false);
    const before = useEditor.getState().files[id];
    expect(before.dirty).toBe(false);
    await useEditor.getState().restoreDrafts();
    const f = useEditor.getState().files[id];
    expect([f.dirty, f.restored, f.gen > before.gen]).toEqual([true, true, true]);
    expect(buffers.get(id)?.initial).toBe("hello (draft)");
    expect(useEditor.getState().order).toEqual([id]);
  });

  it("aren't replaced by the file on disk when it finishes loading after them", async () => {
    let finish: (v: unknown) => void = () => {};
    let asked: () => void = () => {};
    const reading = new Promise<void>((r) => (asked = r));
    readFile = () => {
      asked();
      readFile = async () => onDisk; // the draft's own check of the disk
      return new Promise((r) => (finish = r));
    };
    const opening = useEditor.getState().open("@local", "/r/notes.txt", null, undefined, false);
    await reading;
    expect(useEditor.getState().files[id].kind).toBe("loading");
    await useEditor.getState().restoreDrafts();
    finish(onDisk);
    await opening;
    expect(useEditor.getState().files[id].dirty).toBe(true);
    expect(buffers.get(id)?.initial).toBe("hello (draft)");
  });

  it("leave a file that was edited since alone", async () => {
    await useEditor.getState().open("@local", "/r/notes.txt", null, undefined, false);
    useEditor.setState((s) => ({ files: { ...s.files, [id]: { ...s.files[id], dirty: true } } }));
    const gen = useEditor.getState().files[id].gen;
    await useEditor.getState().restoreDrafts();
    expect(useEditor.getState().files[id].gen).toBe(gen);
    expect(buffers.get(id)?.initial).toBe("hello");
  });

  it("come back for files that aren't open", async () => {
    await useEditor.getState().restoreDrafts();
    expect(useEditor.getState().files[id]?.restored).toBe(true);
  });
});
