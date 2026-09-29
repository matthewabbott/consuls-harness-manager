// End-to-end: a shell on This PC started through the new-pane dialog, driven through the
// real UI (Windows: PowerShell by default; SHELL=git-bash etc. picks another).
//
//   node scripts/e2e/cdp.mjs scripts/e2e/local-shell.mjs
import { bufferOf, noTmux } from "./term.mjs";

const SHELL = process.env.SHELL_NAME ?? "PowerShell";

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
  const has = async (s) => ((await buf(40))?.lines ?? []).some((l) => l.includes(s));
  const click = (sel, text) =>
    js(`const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true`);

  await until("This PC section", () => js(`return [...document.querySelectorAll("main section h2")].some(h => h.textContent === "This PC")`), 15000);
  await js(`[...document.querySelectorAll("main section")].find(s => s.querySelector("h2")?.textContent === "This PC").querySelector('button[title^="New pane"]').click(); return true`);
  await until("dialog", () => js(`return !!document.querySelector("select")`));
  await js(noTmux);
  await until("dialog with a shell picker", () => click("button", SHELL));
  await until("Shell harness picked", () => js(`const b = [...document.querySelectorAll("button")].find(e => e.textContent.includes("just a terminal")); b?.click(); return !!b`));
  await until("folder listing loaded", () => js(`return [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Users")`));
  await until("open the shell", () => click("button", "Open shell"));
  await until("expanded, red frame, xterm", () => js(`return !!document.querySelector(".xterm") && !!document.querySelector('[class*="ring-rose-500/40"]')`));
  await until("prompt", async () => (await buf(3))?.lines?.length > 0, 15000);
  await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);

  const ps = SHELL.includes("PowerShell");
  await text(ps ? 'Write-Output "local-$(6*7)"' : 'echo "local-$((6*7))"');
  await key("Enter");
  await until("typing reaches the local shell", () => has("local-42"));

  const size = await buf(1);
  await text(ps ? 'Write-Output "size=$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)"' : 'echo "size=$(tput cols)x$(tput lines)"');
  await key("Enter");
  await until(`shell size matches xterm (${size.cols}x${size.rows})`, () => has(`size=${size.cols}x${size.rows}`));

  // Arrow-key history recall goes through xterm's own key encoding.
  await key("Up");
  await key("Up");
  await key("Enter");
  await until("Up-arrow history recall", async () => ((await buf(60))?.lines ?? []).filter((l) => l.includes("local-42")).length >= 2);

  // Quit confirmation modal (as the tray's Quit shows it when local shells run); keep running.
  await js(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "confirm-quit", payload: 1 }); return true`);
  await until("quit confirmation shown", () => js(`return document.body.textContent.includes("A shell on this PC is still running")`));
  await until("keep running", () => click("button", "Keep running"));

  await text("exit");
  await key("Enter");
  await until("exit → ended banner", () => js(`return document.body.textContent.includes("Session ended")`));
  await until("dismiss", () => click("button", "Dismiss"));
  await until("back to the grid", () => js(`return !document.querySelector(".xterm")`));
  log("all local e2e checks passed");
}
