// In-memory file system for the mock backend (browser dev), so the Files explorer can be
// exercised without a machine.

import type { DirListing } from "./bindings/DirListing";
import type { FsOp } from "./bindings/FsOp";
import type { GitStatus } from "./bindings/GitStatus";

interface Node {
  dir: boolean;
  size: number;
  mtime: number;
  text?: string;
}

const now = Math.floor(Date.now() / 1000);
const nodes = new Map<string, Node>(); // key: `${host}\n${path}`
const k = (host: string, path: string) => `${host}\n${path}`;

function add(host: string, path: string, dir = false, size = 0) {
  const parts = path.split("/").filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "");
  for (let i = 1; i < parts.length; i++) {
    const p = (drive ? "" : "/") + parts.slice(0, i).join("/");
    if (!nodes.has(k(host, p))) nodes.set(k(host, p), { dir: true, size: 0, mtime: now });
  }
  nodes.set(k(host, path), { dir, size, mtime: now - Math.floor(Math.random() * 90000) });
}

const REPO = "/home/consulear/code/consuls";
for (const d of ["Programming/terrarium-annotator", "Programming/open-webui", "models", "notes", ".config"]) add("spark-d683", `/home/consulear/${d}`, true);
for (const f of ["src/App.tsx", "src/main.tsx", "src/components/Grid.tsx", "src/components/MiniTile.tsx", "crates/chm-core/src/lib.rs", "README.md", "package.json", ".gitignore", "target/debug/app"])
  add("spark-d683", `${REPO}/${f}`, false, 1200 + f.length * 97);
// A big folder, for scrolling.
for (let i = 0; i < 5000; i++) add("spark-d683", `/home/consulear/models/checkpoints/step-${String(i).padStart(5, "0")}.pt`, false, 4096);
for (const f of ["code/notes.txt", "Documents/todo.md"]) add("@local", `C:/Users/consul/${f}`, false, 300);
for (const f of ["a/programming/consuls-harness-manager/README.md", "a/programming/open-webui/package.json", "games/.keep"])
  add("@local", `D:/${f}`, false, 800);

/** The mock PC's drives. */
export const MOCK_DRIVES = [
  { path: "C:/", label: "C:", kind: "fixed" as const, volume: null },
  { path: "D:/", label: "D:", kind: "fixed" as const, volume: "New Volume" },
];

const SAMPLE: Record<string, string> = {
  "App.tsx": [
    'import { useState } from "react";',
    "",
    "export default function App() {",
    "  const [n, setN] = useState(0);",
    "  return <button onClick={() => setN(n + 1)}>clicked {n} times</button>;",
    "}",
    "",
  ].join("\n"),
  "README.md": ["# consuls", "", "A dashboard for the agents on your tailnet.", "", "- live tiles", "- notifications", ""].join("\n"),
  "lib.rs": ["//! chm-core", "", "pub mod fs;", "", "pub fn answer() -> u32 {", "    42", "}", ""].join("\n"),
  "notes.txt": ["buy milk", "call mom", ""].join("\r\n"),
};

function textOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return SAMPLE[name] ?? `// ${name}\n`;
}

export function mockReadFile(host: string, path: string) {
  const n = nodes.get(k(host, path));
  if (!n || n.dir) throw new Error(`${path.split("/").pop()}: No such file`);
  const text = n.text ?? textOf(path);
  n.text = text;
  n.size = new TextEncoder().encode(text).length;
  return { kind: "text" as const, text, bom: false, stamp: { size: n.size, mtime: n.mtime, hash: null } };
}

/** The "committed" version: the sample text, so edits in the mock show in the gutter. */
export function mockGitHead(host: string, path: string) {
  if (host !== "spark-d683" || !path.startsWith(REPO)) return { kind: "notInRepo" as const };
  if (path.endsWith("lib.rs")) return { kind: "untracked" as const };
  return { kind: "text" as const, text: textOf(path) };
}

export function mockStat(host: string, path: string) {
  const n = nodes.get(k(host, path));
  return n ? { size: n.size, mtime: n.mtime, hash: null } : null;
}

export function mockWriteFile(host: string, path: string, text: string, expect: { size: number; mtime: number } | null) {
  const n = nodes.get(k(host, path));
  if (expect && (!n || n.size !== expect.size || n.mtime !== expect.mtime)) {
    throw { kind: "conflict", current: n ? { size: n.size, mtime: n.mtime, hash: null } : null };
  }
  const node = n ?? { dir: false, size: 0, mtime: 0 };
  node.text = text;
  node.size = new TextEncoder().encode(text).length;
  node.mtime = Math.floor(Date.now() / 1000);
  nodes.set(k(host, path), node);
  return { size: node.size, mtime: node.mtime, hash: null };
}

/** Simulates another program editing a file (for trying the conflict flow in the browser). */
export function mockTouch(host: string, path: string, text: string) {
  const n = nodes.get(k(host, path));
  if (!n) return;
  n.text = text;
  n.size = new TextEncoder().encode(text).length;
  n.mtime += 1;
}

export function mockListDir(host: string, path: string): DirListing {
  const home = host === "@local" ? "C:/Users/consul" : "/home/consulear";
  const p = path === "~" || !path ? home : path.replace(/\/$/, "") || "/";
  if (!nodes.get(k(host, p))?.dir && p !== "/") throw new Error(`${p}: No such file`);
  const prefix = p === "/" ? "/" : `${p}/`;
  // Like the real backend, a drive root keeps its slash (`D:/`).
  const shown = /^[A-Za-z]:$/.test(p) ? `${p}/` : p;
  const entries = [];
  for (const [key, n] of nodes) {
    const [h, full] = key.split("\n");
    if (h !== host || !full.startsWith(prefix)) continue;
    const name = full.slice(prefix.length);
    if (!name || name.includes("/")) continue;
    entries.push({ name, isDir: n.dir, isSymlink: false, size: n.size, mtime: n.mtime });
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { path: shown, home, entries };
}

export function mockFsOp(host: string, op: FsOp) {
  const exists = (p: string) => nodes.has(k(host, p));
  switch (op.kind) {
    case "mkdir":
    case "createFile":
      if (exists(op.path)) throw new Error(`${op.path.split("/").pop()}: already exists`);
      add(host, op.path, op.kind === "mkdir");
      return;
    case "rename": {
      if (exists(op.to)) throw new Error(`${op.to.split("/").pop()} already exists`);
      for (const [key, n] of [...nodes]) {
        const [h, full] = key.split("\n");
        if (h === host && (full === op.from || full.startsWith(`${op.from}/`))) {
          nodes.delete(key);
          nodes.set(k(host, op.to + full.slice(op.from.length)), n);
        }
      }
      return;
    }
    case "remove":
      for (const key of [...nodes.keys()]) {
        const [h, full] = key.split("\n");
        if (h === host && (full === op.path || full.startsWith(`${op.path}/`))) nodes.delete(key);
      }
  }
}

export function mockFsCount(host: string, path: string): number {
  let n = 0;
  for (const key of nodes.keys()) {
    const [h, full] = key.split("\n");
    if (h === host && full.startsWith(`${path}/`)) n++;
  }
  return n;
}

export function mockGitStatus(host: string, dir: string): GitStatus | null {
  if (host !== "spark-d683" || !(dir === REPO || dir.startsWith(`${REPO}/`))) return null;
  return {
    root: REPO,
    branch: "v2",
    entries: [
      { path: "src/components/Grid.tsx", status: "modified" },
      { path: "src/main.tsx", status: "added" },
      { path: "README.md", status: "modified" },
      { path: "crates/chm-core/src/lib.rs", status: "untracked" },
      { path: "target/", status: "ignored" },
    ],
  };
}
