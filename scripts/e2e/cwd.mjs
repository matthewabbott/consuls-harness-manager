// End-to-end: a plain shell on This PC reports `cd`, and the Files explorer (following the open
// pane) goes there; a program's OSC 52 copy lands on the clipboard. Closes its shell after.
//
//   node scripts/e2e/cdp.mjs scripts/e2e/cwd.mjs
import { bufferOf } from "./term.mjs";

const FOLDER = process.env.FOLDER ?? "D:/a";

export default async function ({ js, text, key, sleep, log }) {
  const until = async (what, fn, ms = 10000) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) {
        log(`ok   ${what} (${Date.now() - start}ms)`);
        return v;
      }
      if (Date.now() - start > ms) {
        log("     last buffer:", JSON.stringify(await js(bufferOf(6))));
        throw new Error(`timed out: ${what}`);
      }
      await sleep(150);
    }
  };
  const invoke = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
  const mod = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;
  const app = `${mod("app")}.useApp`;
  const files = `${mod("files")}.useFiles`;
  const home = await js(`return ${app}.getState().hosts["@local"].facts.home`);

  const k = await invoke("create_pane", { spec: { host: "@local", cwd: home, harness: "shell", name: null, session: null, args: null, direct: true, shell: "pwsh" } });
  await js(`${app}.getState().setExpanded(${k}); return true`);
  try {
    await js(`const b = document.querySelector('nav button[title="Files"]'); if (!document.querySelector("aside select")) b.click(); ${files}.getState().setFollow(true); return true`);
    await until("prompt", async () => ((await js(bufferOf(3)))?.lines ?? []).length > 0, 15000);
    await until("explorer follows the new shell (home)", () => js(`return ${files}.getState().root?.path?.toLowerCase() === ${JSON.stringify(home.toLowerCase())}`));

    await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);
    await text(`Set-Location -LiteralPath '${FOLDER.replace(/\//g, "\\")}'`);
    await key("Enter");
    await until(`the pane's folder follows cd (${FOLDER})`, () =>
      js(`return Object.values(${app}.getState().panes).flat().find((p) => p.key === ${k})?.currentPath === ${JSON.stringify(FOLDER)}`),
    );
    await until("the explorer follows it too", () => js(`return ${files}.getState().root?.path === ${JSON.stringify(FOLDER)}`));

    // OSC 52 from the shell: the text reaches the clipboard (the window must be focused).
    await text(`[Console]::Write("$([char]27)]52;c;ZTJlLWNvcHk=$([char]7)")`);
    await key("Enter");
    await until("a copy notice", () => js(`return document.body.innerText.includes("from ") && document.body.innerText.includes("Copied 8 characters")`));
  } finally {
    await invoke("terminate_pane", { key: k, force: true }).catch(() => {});
    await js(`${app}.getState().setExpanded(null); return true`);
    log("     closed the test shell");
  }
  log("all cwd e2e checks passed");
}
