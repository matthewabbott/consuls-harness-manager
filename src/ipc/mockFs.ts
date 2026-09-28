// In-memory file system for the mock backend (browser dev), so the Files explorer can be
// exercised without a machine.

import type { DirListing } from "./bindings/DirListing";
import type { FsOp } from "./bindings/FsOp";
import type { GitStatus } from "./bindings/GitStatus";

interface Node {
  dir: boolean;
  size: number;
  mtime: number;
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

export function mockListDir(host: string, path: string): DirListing {
  const home = host === "@local" ? "C:/Users/consul" : "/home/consulear";
  const p = path === "~" || !path ? home : path.replace(/\/$/, "") || "/";
  if (!nodes.get(k(host, p))?.dir && p !== "/") throw new Error(`${p}: No such file`);
  const prefix = p === "/" ? "/" : `${p}/`;
  const entries = [];
  for (const [key, n] of nodes) {
    const [h, full] = key.split("\n");
    if (h !== host || !full.startsWith(prefix)) continue;
    const name = full.slice(prefix.length);
    if (!name || name.includes("/")) continue;
    entries.push({ name, isDir: n.dir, isSymlink: false, size: n.size, mtime: n.mtime });
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { path: p, home, entries };
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
