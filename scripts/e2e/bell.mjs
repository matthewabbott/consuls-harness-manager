// End-to-end: terminal bells. A local Git Bash pane doesn't ping on bell by default; after
// turning it on in the expanded view, a bell rung while the grid is showing makes the tile
// glow with a "Rang the bell" banner.
//
//   node scripts/e2e/cdp.mjs scripts/e2e/bell.mjs

export default async function ({ js, sleep, log }) {
  const until = async (what, fn, ms = 10000) => {
    const start = Date.now();
    for (;;) {
      if (await fn()) {
        log(`ok   ${what} (${Date.now() - start}ms)`);
        return;
      }
      if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
      await sleep(150);
    }
  };
  const invoke = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const pane = async (key) => (await invoke("get_snapshot", {})).panes.find((p) => p.key === key);
  const tile = (key) => `document.querySelector('main article[data-pane="${key}"]')`;

  await invoke("test_chime", { kind: "bell", volume: 0.3 });
  log("ok   bell chime plays");

  const key = await invoke("create_pane", {
    spec: { host: "@local", cwd: "~", harness: "shell", name: null, session: null, args: null, direct: true, shell: "git-bash" },
  });
  await until("tile in the grid", () => js(`return !!${tile(key)}`));
  await sleep(1500);
  const before = await pane(key);
  if (before.bellPings) throw new Error("a plain shell shouldn't ping on bell by default");

  await invoke("send_input", { key, data: "printf '\\a'\r" });
  await sleep(1200);
  if (await js(`return ${tile(key)}.className.includes("glow")`)) throw new Error("bell pinged while off");
  log("ok   bell ignored by default");

  await js(`${tile(key)}.click(); return true`);
  await until("expanded", () => js(`return !!document.querySelector(".xterm")`));
  await js(`[...document.querySelectorAll("main header button")].find(b => b.title.startsWith("Ping when this pane rings")).click(); return true`);
  await until("bell pings on", async () => (await pane(key)).bellPings);
  await js(`[...document.querySelectorAll("main header button")].find(b => b.title.startsWith("Back to grid")).click(); return true`);
  await until("back to grid", () => js(`return !document.querySelector(".xterm")`));

  await invoke("send_input", { key, data: "sleep 0.5; printf '\\a'\r" });
  await until("tile glows with the bell banner", () => js(`const t = ${tile(key)}; return t.className.includes("glow-sky") && t.textContent.includes("Rang the bell")`));

  await invoke("terminate_pane", { key, force: true });
  log("all bell e2e checks passed");
}
