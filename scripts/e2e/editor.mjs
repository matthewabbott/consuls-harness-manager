// End-to-end: editing a file through the real UI — a scratch CRLF+BOM file on a remote
// machine (save keeps both, conflicts from outside writes, hot exit across a reload) and an
// image preview on This PC.
//
//   HOST=spark-d683 REPO=D:/a/programming/consuls-harness-manager node scripts/e2e/cdp.mjs scripts/e2e/editor.mjs

const HOST = process.env.HOST ?? "spark-d683";
const REPO = process.env.REPO ?? "D:/a/programming/consuls-harness-manager";

export default async function ({ js, text, key, sleep, log }) {
  const until = async (what, fn, ms = 10000) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) {
        log(`ok   ${what} (${Date.now() - start}ms)`);
        return v;
      }
      if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
      await sleep(150);
    }
  };
  const invoke = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const mod = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;
  const footer = () => js(`return document.querySelector("main footer")?.textContent ?? ""`);

  const dir = `/tmp/chm-e2e-edit-${Date.now()}`;
  const file = `${dir}/notes.txt`;
  await invoke("fs_op", { host: HOST, op: { kind: "mkdir", path: dir } });
  await invoke("write_file", { host: HOST, path: file, text: "one\r\ntwo\r\n", bom: true, expect: null });

  // Open it from the explorer.
  await js(`if (!document.querySelector("aside select")) document.querySelector('nav button[title="Files"]').click(); return true`);
  await js(`${mod("files")}.useFiles.getState().setRoot({ host: ${JSON.stringify(HOST)}, path: ${JSON.stringify(dir)} }, { follow: false }); return true`);
  await until("file listed", () => js(`return !!document.querySelector('aside [data-path$="notes.txt"]')`));
  await js(`document.querySelector('aside [data-path$="notes.txt"]').click(); return true`);
  await until("editor open", () => js(`return !!document.querySelector(".cm-editor")`));
  await until("status shows CRLF and BOM", async () => (await footer()).includes("CRLF") && (await footer()).includes("with BOM"));

  // Edit and save.
  await js(`document.querySelector(".cm-content").focus(); return true`);
  await key("End", { ctrl: true });
  await text("three");
  await until("dirty", async () => (await footer()).includes("Unsaved"));
  await key("s", { ctrl: true });
  await until("saved", async () => (await footer()).includes("Saved"));
  const saved = await invoke("read_file", { host: HOST, path: file });
  if (saved.kind !== "text" || saved.text !== "one\r\ntwo\r\nthree" || !saved.bom) throw new Error("saved content: " + JSON.stringify(saved));
  log("ok   saved bytes keep CRLF and the BOM");

  // Someone else writes the file while we have unsaved changes.
  await text(" and four");
  await until("dirty again", async () => (await footer()).includes("Unsaved"));
  await invoke("write_file", { host: HOST, path: file, text: "an agent rewrote this\n", bom: false, expect: null });
  await until("conflict banner", () => js(`return document.body.textContent.includes("The file changed on disk")`), 8000);
  await js(`[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Overwrite").click(); return true`);
  await until("overwrote", async () => (await footer()).includes("Saved") && !(await js(`return document.body.textContent.includes("The file changed on disk")`)));
  const after = await invoke("read_file", { host: HOST, path: file });
  if (!after.text.endsWith("three and four")) throw new Error("overwrite content: " + JSON.stringify(after.text));
  log("ok   overwrite after a conflict");

  // Hot exit: an unsaved change survives reloading the UI.
  await js(`document.querySelector(".cm-content").focus(); return true`);
  await key("End", { ctrl: true });
  await text(" (draft)");
  await until("dirty", async () => (await footer()).includes("Unsaved"));
  await sleep(800); // drafts are written after a short pause
  await js(`setTimeout(() => location.reload(), 50); return true`);
  await sleep(2500);
  await until("unsaved copy restored as a dirty tile", () =>
    js(`const t = document.querySelector('article[data-file$="notes.txt"]'); return !!t && !!t.querySelector('[title="Unsaved changes"]') && t.textContent.includes("(draft)")`),
  );
  await js(`document.querySelector('article[data-file$="notes.txt"]').click(); return true`);
  await until("reopened with the draft", () => js(`return [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("(draft)"))`));
  await js(`const s = ${mod("editor")}.useEditor.getState(); s.close(Object.keys(s.files).find((k) => k.endsWith("notes.txt"))); return true`);

  // Image preview on This PC.
  await js(`await ${mod("editor")}.useEditor.getState().open("@local", ${JSON.stringify(`${REPO}/src-tauri/icons/128x128.png`)}); return true`);
  await until("image preview renders", () => js(`const i = document.querySelector("main img"); return !!i && i.complete && i.naturalWidth > 0`));
  await js(`const s = ${mod("editor")}.useEditor.getState(); s.close(s.active); return true`);

  await invoke("fs_op", { host: HOST, op: { kind: "remove", path: dir } });
  log("all editor e2e checks passed");
}
