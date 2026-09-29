// End-to-end: renaming a pane and pasting images, in a Git Bash shell on This PC.
//   - Rename: double-click the expanded pane's title; clear it again.
//   - Composer: a pasted image is saved on the machine (raw-bytes IPC), shown as a thumbnail,
//     and its path follows the text when sent (a shell gets `ls -l <path>`).
//   - Terminal: a pasted image's path is pasted into the shell's line.
// Removes the images it saved and closes the shell.
//
//   node scripts/e2e/cdp.mjs scripts/e2e/paste.mjs
import { bufferOf, noTmux } from "./term.mjs";

const SHELL = process.env.SHELL_NAME ?? "Git Bash";

export default async function ({ js, text, key, sleep, log }) {
  const buf = (n = 12) => js(bufferOf(n));
  const until = async (what, fn, ms = 10000) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) {
        log(`ok   ${what} (${Date.now() - start}ms)`);
        return v;
      }
      if (Date.now() - start > ms) {
        log("     last buffer:", JSON.stringify(await buf(8)));
        throw new Error(`timed out: ${what}`);
      }
      await sleep(150);
    }
  };
  const lines = async (n = 40) => (await buf(n))?.lines ?? [];
  const click = (sel, label) =>
    js(`const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true`);
  const invoke = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
  const mod = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;
  const app = `${mod("app")}.useApp`;
  const pane = () => js(`const s = ${app}.getState(); return Object.values(s.panes).flat().find((p) => p.key === s.expanded) ?? null`);
  // A PNG made in the page, pasted as a ClipboardEvent into `selector`.
  const pasteImage = (selector) =>
    js(`const c = new OffscreenCanvas(64, 40); const g = c.getContext("2d"); g.fillStyle = "#f5a25d"; g.fillRect(0, 0, 64, 40);
        const blob = await c.convertToBlob({ type: "image/png" }); const dt = new DataTransfer();
        dt.items.add(new File([blob], "image.png", { type: "image/png" }));
        const el = document.querySelector(${JSON.stringify(selector)}); el.focus();
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return blob.size`);
  const saved = [];

  await until("This PC section", () => js(`return [...document.querySelectorAll("main section h2")].some(h => h.textContent === "This PC")`), 15000);
  await js(`${app}.getState().setExpanded(null); return true`);
  await js(`[...document.querySelectorAll("main section")].find(s => s.querySelector("h2")?.textContent === "This PC").querySelector('button[title^="New pane"]').click(); return true`);
  await until("dialog", () => js(`return !!document.querySelector("select")`));
  await js(noTmux);
  await until(`dialog: ${SHELL}`, () => click("button", SHELL));
  await until("Shell harness picked", () => js(`const b = [...document.querySelectorAll("button")].find(e => e.textContent.includes("just a terminal")); b?.click(); return !!b`));
  await js(`const t = document.querySelector('button[title^="Plain shell"]'); t?.click(); return true`);
  await until("open the shell", () => click("button", "Open shell"));
  await until("expanded, xterm", () => js(`return !!document.querySelector(".xterm")`));
  await until("prompt", async () => (await lines(3)).length > 0, 15000);
  const { key: paneKey } = await pane();

  try {
    // --- rename from the header
    await js(`document.querySelector('header div[title^="Double-click to rename"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true`);
    await until("name field", () => js(`return document.activeElement?.getAttribute("aria-label") === "Pane name"`));
    await text("e2e #1 · shell");
    await key("Enter");
    await until("pane named", async () => (await pane())?.name === "e2e #1 · shell");
    await until("header shows the name", () => js(`return document.querySelector('header div[title^="Double-click to rename"]')?.textContent === "e2e #1 · shell"`));
    await js(`await (await import("/src/ipc/backend.ts")).backend().then((b) => b.renamePane(${paneKey}, null)); return true`);
    await until("name cleared", async () => (await pane())?.name === null);

    // --- composer: the image is saved on the machine, and its path follows the text
    const size = await pasteImage(".cm-content");
    const thumb = `document.querySelector('img[alt="Pasted image"]')?.parentElement?.title ?? ""`;
    const title = await until("thumbnail saved on the machine", () => js(`const t = ${thumb}; return t.includes("Saved on the machine as") ? t : null`));
    const path = title.split("Saved on the machine as ")[1];
    saved.push(path);
    log(`     saved at ${path}`);
    const stat = await invoke("stat_file", { host: "@local", path });
    if (stat?.size !== size) throw new Error(`saved ${stat?.size} bytes, pasted ${size}`);
    log("ok   the file on disk is the pasted image");
    await js(`document.querySelector(".cm-content").focus(); return true`);
    await text("ls -l");
    await key("Enter");
    await until("thumbnail gone after sending", () => js(`return !document.querySelector('img[alt="Pasted image"]')`));
    const name = path.split("/").pop();
    // `ls -l` prints the size and the name (which may wrap onto the next line).
    await until("the shell ran `ls -l <image>`", async () => {
      const out = (await lines()).join("");
      return out.includes(` ${size} `) && out.split(name).length > 2;
    });

    // --- terminal: the path is pasted into the line (not run)
    await pasteImage(".xterm-helper-textarea");
    const line = await until("path pasted at the prompt", async () => (await lines(1)).find((l) => l.startsWith("$ ") && /paste-\d+-[0-9a-f]+\.png/.test(l)));
    const second = line.match(/[A-Za-z]:\/.*?paste-\d+-[0-9a-f]+\.png/)?.[0];
    if (second) saved.push(second);
    await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);
    await key("u", { ctrl: true });
  } finally {
    for (const p of saved) await invoke("fs_op", { host: "@local", op: { kind: "remove", path: p } }).catch(() => {});
    await js(`document.querySelector(".xterm-helper-textarea")?.focus(); return true`);
    await text("exit");
    await key("Enter");
    await until("exit → ended banner", () => js(`return document.body.textContent.includes("Session ended")`));
    await until("dismiss", () => click("button", "Dismiss"));
  }
  log("all paste e2e checks passed");
}
