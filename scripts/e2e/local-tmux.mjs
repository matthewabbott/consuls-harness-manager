// End-to-end: a tmux pane on This PC (Cygwin), made through the real new-pane dialog, typed into
// and closed. Start the app with CHM_TMUX_SOCKET=<private name> so it uses its own tmux server:
//
//   CHM_TMUX_SOCKET=chm-e2e WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./target/debug/consuls.exe
//   node scripts/e2e/cdp.mjs scripts/e2e/local-tmux.mjs
import { bufferOf } from "./term.mjs";

const FOLDER = process.env.FOLDER ?? "D:/a";

export default async function ({ js, text, key, sleep, log }) {
  const buf = (n = 20) => js(bufferOf(n));
  const until = async (what, fn, ms = 15000) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) {
        log(`ok   ${what} (${Date.now() - start}ms)`);
        return v;
      }
      if (Date.now() - start > ms) {
        log("     last buffer:", JSON.stringify(await buf(6)));
        throw new Error(`timed out: ${what}`);
      }
      await sleep(150);
    }
  };
  const mod = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;
  const app = `${mod("app")}.useApp`;
  const click = (sel, label) =>
    js(`const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true`);

  await until("This PC has tmux", () => js(`return !!${app}.getState().hosts["@local"]?.facts?.tmuxVersion`));
  await js(`${app}.getState().openNewPane("@local", ${JSON.stringify(FOLDER)}); return true`);
  await until("Shell harness picked", () => js(`const b = [...document.querySelectorAll("button")].find(e => e.textContent.includes("just a terminal")); b?.click(); return !!b`));
  await until("tmux session choice offered", () => js(`return [...document.querySelectorAll("select option")].some(o => o.textContent === "New session")`));
  await until("no shell picker for a tmux pane", () => js(`return ![...document.querySelectorAll("div")].some(d => d.textContent === "Shell")`));
  await until(`folder ${FOLDER} listed`, () => js(`return document.querySelector("form input")?.value === ${JSON.stringify(FOLDER)}`));
  await until("open the shell", () => click("button", "Open shell"));

  const pane = await until("expanded tmux pane", () =>
    js(`const k = ${app}.getState().expanded; const p = Object.values(${app}.getState().panes).flat().find(p => p.key === k); return p?.kind === "tmux" && p.host === "@local" ? p : null`),
  );
  log(`     pane ${pane.tmux.paneId} in ${pane.currentPath} (session ${pane.tmux.sessionName})`);
  if (pane.currentPath.toLowerCase() !== FOLDER.toLowerCase()) throw new Error(`folder: ${pane.currentPath}`);
  await until("prompt", async () => ((await buf(3))?.lines ?? []).length > 0);
  await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);
  await text('echo "local-tmux-$((6*7))"');
  await key("Enter");
  await until("typing reaches the tmux pane", async () => ((await buf(20))?.lines ?? []).some((l) => l.includes("local-tmux-42")));

  await js(`await window.__TAURI_INTERNALS__.invoke("terminate_pane", { key: ${pane.key}, force: true }); ${app}.getState().setExpanded(null); return true`);
  await until("pane gone", () => js(`return !Object.values(${app}.getState().panes).flat().some(p => p.key === ${pane.key})`));
  log("all local tmux e2e checks passed");
}
