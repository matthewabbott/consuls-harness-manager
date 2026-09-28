// End-to-end: a direct (no tmux) shell on a connected machine, driven through the real UI.
// Never touches the user's tmux sessions (tmux inside the shell uses a private -L socket).
//
//   HOST=spark-d683 node scripts/e2e/cdp.mjs scripts/e2e/direct-shell.mjs
//
// (The app must be running with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333.)

import { bufferOf } from "./term.mjs";

const HOST = process.env.HOST ?? "spark-d683";

export default async function ({ js, text, key, sleep, log }) {
  const buf = (n = 12) => js(bufferOf(n));
  const until = async (what, fn, ms = 8000) => {
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

  await until(`${HOST} connected`, () => js(`return [...document.querySelectorAll("section h2")].some(h => h.textContent === "${HOST}") && document.body.textContent.includes("Connected")`), 30000);

  // Create through the backend (the dialog calls the same thing), then open its tile.
  const paneKey = await js(`
    return await window.__TAURI_INTERNALS__.invoke("create_pane", { spec: { host: "${HOST}", cwd: "/tmp", harness: "shell", name: null, session: null, args: null, direct: true } });
  `);
  log("     created direct pane key", paneKey);
  await until("direct tile in the grid", () => js(`return [...document.querySelectorAll("article")].some(a => a.className.includes("rose") && a.textContent.includes("direct"))`));
  await js(`[...document.querySelectorAll("article")].find(a => a.className.includes("rose") && a.textContent.includes("direct")).click(); return true`);
  await until("expanded with a red frame and xterm", () => js(`return !!document.querySelector(".xterm") && !!document.querySelector('[class*="ring-rose-500/40"]')`));
  await until("shell prompt in the terminal", async () => (await buf(3))?.lines?.length > 0);
  await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);

  await text("printf 'hello-%s\\n' $((6*7))");
  await key("Enter");
  await until("typing reaches the shell", () => has("hello-42"));

  const size = await buf(1);
  await text("echo cols=$(tput cols) rows=$(tput lines)");
  await key("Enter");
  await until(`shell size matches xterm (${size.cols}x${size.rows}, auto-fit)`, () => has(`cols=${size.cols} rows=${size.rows}`));

  // Device-attributes query: exactly one reply (the core's). If xterm answered too, the second
  // reply would land on the next prompt as junk.
  await text("printf '\\033[c'; IFS= read -rs -t 2 -d c r; echo \"da=${#r}\"; sleep 0.5; echo after-da");
  await key("Enter");
  await until("DA query answered once", () => has("after-da"));
  const tail = (await buf(4)).lines;
  if (tail.some((l) => l.includes("?") && l.includes("c") && !l.includes("printf") && !l.includes("da="))) throw new Error("duplicate query reply: " + JSON.stringify(tail));
  log("     ", JSON.stringify(tail.slice(-3)));

  await text("sleep 100");
  await key("Enter");
  await sleep(500);
  await key("c", { ctrl: true });
  await text("echo interrupted-ok");
  await key("Enter");
  await until("Ctrl+C interrupts", () => has("interrupted-ok"));

  await text("vim -u NONE -N /tmp/chm-e2e-$$.txt");
  await key("Enter");
  await until("vim on the alternate screen", async () => (await buf(1))?.alt);
  await text("ihello from vim");
  await key("Escape");
  await text(":wq");
  await key("Enter");
  await until("vim exits back to the shell", async () => (await buf(1))?.alt === false);

  await text("tmux -L chm-e2e -f /dev/null new -s e2e");
  await key("Enter");
  await until("tmux inside the direct shell", async () => (await buf(3))?.alt);
  await key("b", { ctrl: true });
  await text("d");
  await until("Ctrl+b d detaches", () => has("[detached"));
  // Also stop an ssh-agent the login shell's rc files may have started (it would outlive us).
  await text('tmux -L chm-e2e kill-server; rm -f /tmp/chm-e2e-*.txt /tmp/tmux-$(id -u)/chm-e2e; [ -n "$SSH_AGENT_PID" ] && kill $SSH_AGENT_PID; echo cleaned');
  await key("Enter");
  await until("cleanup", () => has("cleaned"));

  // Composer path (paste + Enter through the core).
  await js(`
    const ed = document.querySelector(".cm-content");
    ed.focus();
    return true;
  `);
  await text("echo from-composer");
  await key("Enter");
  await until("composer submit reaches the shell", () => has("from-composer"));

  await js(`return await window.__TAURI_INTERNALS__.invoke("terminate_pane", { key: ${paneKey}, force: true })`);
  await until("pane closed", () => js(`return !document.querySelector('[class*="ring-rose-500/40"]')`));
  log("all e2e checks passed");
}
