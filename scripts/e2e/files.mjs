// End-to-end: the Files explorer against a real machine (a scratch folder under /tmp) and
// This PC (git badges for this repository).
//
//   HOST=spark-d683 REPO=D:/a/programming/consuls-harness-manager node scripts/e2e/cdp.mjs scripts/e2e/files.mjs

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
  // The app's own files store (same module instance the UI uses).
  const store = `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/files.ts")).pop() ?? "/src/store/files.ts")).useFiles`;
  const setRoot = (host, path) => js(`(${store}).getState().setRoot({ host: ${JSON.stringify(host)}, path: ${JSON.stringify(path)} }, { follow: false }); return true`);
  const names = () => js(`return [...document.querySelectorAll("aside [data-path]")].map((e) => e.dataset.path.split("/").pop())`);
  const row = (name) => `[...document.querySelectorAll("aside [data-path]")].find((e) => e.dataset.path.split("/").pop() === ${JSON.stringify(name)})`;

  await js(`const b = document.querySelector('nav button[title="Files"]'); if (!document.querySelector("aside select")) b.click(); return true`);
  await until("Files panel", () => js(`return !!document.querySelector("aside select")`));

  // --- remote: scratch folder
  const dir = `/tmp/chm-e2e-files-${Date.now()}`;
  await invoke("fs_op", { host: HOST, op: { kind: "mkdir", path: dir } });
  await setRoot(HOST, dir);
  await until("empty scratch folder shown", () => js(`return document.body.textContent.includes("Empty folder")`));

  await js(`document.querySelector('aside button[title="New folder"]').click(); return true`);
  await until("inline name box", () => js(`return !!document.querySelector("aside input")`));
  await text("sub");
  await key("Enter");
  await until("folder created", async () => (await names()).includes("sub"));

  await js(`document.querySelector('aside button[title="New file"]').click(); return true`);
  await until("inline name box", () => js(`return !!document.querySelector("aside input")`));
  await text("notes.txt");
  await key("Enter");
  await until("file created and selected", () => js(`return ${row("notes.txt")}?.className.includes("bg-sky") ?? false`));

  await js(`document.querySelector("aside [tabindex='0']").focus(); return true`);
  await key("F2");
  await until("rename box has the old name", () => js(`return document.querySelector("aside input")?.value === "notes.txt"`));
  await js(`const i = document.querySelector("aside input"); i.select(); return true`);
  await text("README.md");
  await key("Enter");
  await until("renamed", async () => {
    const n = await names();
    return n.includes("README.md") && !n.includes("notes.txt");
  });

  // Creating over an existing name fails visibly and changes nothing.
  await js(`document.querySelector('aside button[title="New file"]').click(); return true`);
  await until("inline name box", () => js(`return !!document.querySelector("aside input")`));
  await text("README.md");
  await key("Enter");
  await until("duplicate refused with an error", () => js(`return !!document.querySelector('aside [class*="text-rose-300"]')`));

  // Delete the scratch folder's subfolder through the confirmation.
  await js(`${row("sub")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 200 })); return true`);
  await js(`[...document.querySelectorAll(".fixed.inset-0 button")].find((b) => b.textContent.startsWith("Delete")).click(); return true`);
  await until("delete confirmation with a count", () => js(`return [...document.querySelectorAll("p")].some((p) => p.textContent.includes("(it's empty)"))`));
  await js(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Delete").click(); return true`);
  await until("folder deleted", async () => !(await names()).includes("sub"));
  await invoke("fs_op", { host: HOST, op: { kind: "remove", path: dir } });
  log("ok   scratch folder cleaned up");

  // --- This PC: git badges for this repo
  await setRoot("@local", REPO);
  await until("repo listed with its branch", () => js(`return !!document.querySelector('aside [title^="git:"]')`));
  const status = await invoke("git_status", { host: "@local", dir: REPO });
  const changed = status.entries.filter((e) => e.status !== "ignored" && !e.path.includes("/"));
  log(`     ${status.entries.length} git entries; top-level changes: ${changed.map((e) => `${e.path}=${e.status}`).join(", ") || "none"}`);
  const ignored = status.entries.find((e) => e.status === "ignored" && !e.path.slice(0, -1).includes("/"));
  if (ignored) {
    const name = ignored.path.replace(/\/$/, "");
    await until(`ignored "${name}" is dimmed`, () => js(`return ${row(name)}?.innerHTML.includes("text-mist-600") ?? false`));
  }
  const top = status.entries.find((e) => e.status !== "ignored");
  if (top) {
    const first = top.path.split("/")[0];
    await until(`"${first}" shows a ${top.status} badge`, () => js(`const r = ${row(first)}; return !!r && /text-(ember|jade|rose|sky)-/.test(r.innerHTML)`));
  }
  log("all files e2e checks passed");
}
