// End-to-end: the editor's git gutter matches `git diff` for a file in this repository, and an
// untracked file is all "added".
//
//   FILE=src/components/FileEditor.tsx node scripts/e2e/cdp.mjs scripts/e2e/gutter.mjs
// (FILE must differ from HEAD; run from the repository root.)
import { execFileSync } from "node:child_process";

const REPO = process.cwd().replace(/\\/g, "/");
const FILE = process.env.FILE ?? "src/components/FileEditor.tsx";

/** Expected markers from `git diff -U0`: line number (new file) → kind. */
function expected() {
  const diff = execFileSync("git", ["diff", "-U0", "--no-color", "--", FILE], { encoding: "utf8" });
  const out = {};
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [oldCount, newStart, newCount] = [Number(m[2] ?? 1), Number(m[3]), Number(m[4] ?? 1)];
    if (newCount === 0) out[Math.max(newStart + 1, 1)] = "deleted";
    else for (let i = 0; i < newCount; i++) out[newStart + i] = oldCount === 0 ? "added" : "modified";
  }
  return out;
}

export default async function ({ js, sleep, log }) {
  const want = expected();
  if (Object.keys(want).length === 0) throw new Error(`${FILE} doesn't differ from HEAD; pick another FILE`);
  const mod = (path) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes(${JSON.stringify(path)})).pop() ?? ${JSON.stringify(path)}))`;
  const markers = () =>
    js(`
      const { EditorView } = await import(performance.getEntriesByType("resource").map((e) => e.name).find((u) => u.includes("@codemirror_view")));
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
      if (!view) return null;
      const g = ${mod("/src/editor/gitGutter.ts")};
      const out = {};
      g.computeMarkers(view.state).between(0, view.state.doc.length, (from, _to, m) => { out[view.state.doc.lineAt(from).number] = m.kind; });
      return out;`);

  await js(`const s = ${mod("/src/store/editor.ts")}.useEditor.getState(); for (const id of Object.keys(s.files)) if (!s.files[id].dirty) s.close(id); await s.open("@local", ${JSON.stringify(`${REPO}/${FILE}`)}); return true`);
  let got = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    got = await markers();
    if (got && Object.keys(got).length) break;
  }
  const same = JSON.stringify(got) === JSON.stringify(want);
  log(same ? `ok   gutter matches git diff (${Object.keys(want).length} marked lines)` : `FAILED gutter:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  if (!same) throw new Error("gutter mismatch");

  // An untracked file: all lines added.
  const scratch = `${REPO}/chm-gutter-e2e.tmp.txt`;
  await js(`await window.__TAURI_INTERNALS__.invoke("write_file", { host: "@local", path: ${JSON.stringify(scratch)}, text: "one\\ntwo\\nthree\\n", bom: false, expect: null }); return true`);
  await js(`await ${mod("/src/store/editor.ts")}.useEditor.getState().open("@local", ${JSON.stringify(scratch)}); return true`);
  let untracked = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    untracked = await markers();
    if (untracked && Object.keys(untracked).length) break;
  }
  if (JSON.stringify(untracked) !== JSON.stringify({ 1: "added", 2: "added", 3: "added", 4: "added" })) throw new Error("untracked: " + JSON.stringify(untracked));
  log("ok   untracked file is all added");
  await js(`const s = ${mod("/src/store/editor.ts")}.useEditor.getState(); for (const id of Object.keys(s.files)) if (!s.files[id].dirty) s.close(id); return true`);
  await js(`await window.__TAURI_INTERNALS__.invoke("fs_op", { host: "@local", op: { kind: "remove", path: ${JSON.stringify(scratch)} } }); return true`);
  log("all gutter e2e checks passed");
}
