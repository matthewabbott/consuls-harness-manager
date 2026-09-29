// End-to-end: a tmux pane on This PC (Cygwin), made through the real new-pane dialog, typed into
// and closed, with the prefix keys (Ctrl+B %, o, ",", d). Start the app with
// CHM_TMUX_SOCKET=<private name> so it uses its own tmux server:
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

  // tmux prefix keys, handled by the app and aimed at this pane.
  const prefixKey = (k, extra = {}) =>
    js(`const t = document.querySelector(".xterm-helper-textarea"); t.focus();
        t.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true }));
        t.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} })); return true`);
  const expanded = () => js(`const k = ${app}.getState().expanded; return Object.values(${app}.getState().panes).flat().find(p => p.key === k) ?? null`);
  await prefixKey("%", { shiftKey: true });
  const split = await until("Ctrl+B % splits and shows the new pane", async () => {
    const p = await expanded();
    return p && p.key !== pane.key && p.tmux?.windowId === pane.tmux.windowId ? p : null;
  });
  await prefixKey("o");
  await until("Ctrl+B o goes back to the first pane", async () => (await expanded())?.key === pane.key);
  await prefixKey(",");
  await until("Ctrl+B , asks for the window's name", () => js(`return document.activeElement?.getAttribute("aria-label") === "tmux window name"`));
  await js(`const i = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "e2e #win");
            i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true`);
  await until("tmux window renamed", async () => (await expanded())?.tmux?.windowName === "e2e #win");
  await prefixKey("d");
  await until("Ctrl+B d goes back to the grid", () => js(`return ${app}.getState().expanded === null`));

  for (const k of [split.key, pane.key]) await js(`await window.__TAURI_INTERNALS__.invoke("terminate_pane", { key: ${k}, force: true }); return true`);
  await until("panes gone", () => js(`return !Object.values(${app}.getState().panes).flat().some(p => p.key === ${pane.key} || p.key === ${split.key})`));
  log("all local tmux e2e checks passed");
}
