// End-to-end: clicking `src/App.tsx:42` printed in a terminal opens that file at line 42 on the
// pane's machine (a Git Bash pane on This PC, in this repository), beside the pane, which keeps
// the composer; Ctrl+click does too. A URL hard-wrapped across rows is Ctrl+clicked whole.
//
//   node scripts/e2e/cdp.mjs scripts/e2e/links.mjs   (from the repository root)

const REPO = process.cwd().replace(/\\/g, "/");

export default async function ({ js, text, key, click, sleep, log }) {
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
  const mod = (path) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes(${JSON.stringify(path)})).pop() ?? ${JSON.stringify(path)}))`;
  // The file the reference opens: src/App.tsx under the pane's folder (this repository).
  const appFile = `Object.values(${mod("/src/store/editor.ts")}.useEditor.getState().files).find((f) => f.host === "@local" && f.path.endsWith("/src/App.tsx"))`;
  const opened = () => js(`return !!${appFile}`);
  const closeFile = () => js(`const f = ${appFile}; if (f) ${mod("/src/store/editor.ts")}.useEditor.getState().close(f.id); return true`);
  const atLine42 = () => js(`return [...document.querySelectorAll("main footer")].some((f) => f.textContent.startsWith("Ln 42,"))`);

  const paneKey = await invoke("create_pane", {
    spec: { host: "@local", cwd: REPO, harness: "shell", name: null, session: null, args: null, direct: true, shell: "git-bash" },
  });
  await js(`${mod("/src/store/app.ts")}.useApp.getState().setExpanded(${paneKey}); return true`);
  await until("terminal open", () => js(`return !!document.querySelector(".xterm")`));
  await sleep(1200);
  await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);
  await text(`echo "open src/App.tsx:42 please"`);
  await key("Enter");

  // Screen position of the reference in the rendered terminal.
  const where = () =>
    js(`
      const el = document.querySelector(".xterm")?.parentElement;
      let f = el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))], term = null;
      while (f && !term) { let h = f.memoizedState; while (h && !term) { const v = h.memoizedState; if (v && v.current && v.current.buffer && v.current.cols) term = v.current; h = h.next; } f = f.return; }
      const b = term.buffer.active;
      for (let y = b.length - 1; y >= 0; y--) {
        const s = b.getLine(y)?.translateToString(true) ?? "";
        const i = s.indexOf("src/App.tsx:42");
        if (i >= 0 && !s.includes("echo")) {
          const row = y - b.viewportY;
          const cell = term._core._renderService.dimensions.css.cell;
          const r = document.querySelector(".xterm-screen").getBoundingClientRect();
          return { x: r.left + (i + 7) * cell.width, y: r.top + (row + 0.5) * cell.height };
        }
      }
      return null;`);
  const pos = await until("reference printed", where);

  if (await opened()) await closeFile();
  await click(pos.x, pos.y);
  await until("a click opens src/App.tsx", opened);
  await until("cursor on line 42", atLine42);
  if ((await js(`return ${mod("/src/store/app.ts")}.useApp.getState().expanded`)) !== paneKey) throw new Error("the composer left the pane");
  log("ok   the pane keeps the composer");
  await closeFile();

  await sleep(500);
  await click(pos.x, pos.y, { ctrl: true });
  await until("Ctrl+click opens it too", opened);
  await until("cursor on line 42 again", atLine42);
  await closeFile();
  await until("file closed", async () => !(await opened()));
  await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);

  // A URL hard-wrapped the way Claude Code prints its sign-in link: Ctrl+clicking its second
  // row still gets the whole URL. (http, so it's copied rather than opened in a browser.)
  const cols = await js(`
    const el = document.querySelector(".xterm")?.parentElement;
    let f = el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))], term = null;
    while (f && !term) { let h = f.memoizedState; while (h && !term) { const v = h.memoizedState; if (v && v.current && v.current.buffer && v.current.cols) term = v.current; h = h.next; } f = f.return; }
    return term.cols;`);
  const url = `http://example.invalid/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9&redirect_uri=http%3A%2F%2Fexample.invalid%2Fcallback&state=${"x".repeat(cols)}42`;
  const width = cols - 2;
  const rows = url.match(new RegExp(`.{1,${width}}`, "g")).map((c) => `  ${c}`).join("\n");
  await text(`echo ${Buffer.from(rows + "\n").toString("base64")} | base64 -d`);
  await key("Enter");
  const second = url.slice(width, width + 12);
  const rowPos = () =>
    js(`
      const el = document.querySelector(".xterm")?.parentElement;
      let f = el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))], term = null;
      while (f && !term) { let h = f.memoizedState; while (h && !term) { const v = h.memoizedState; if (v && v.current && v.current.buffer && v.current.cols) term = v.current; h = h.next; } f = f.return; }
      const b = term.buffer.active;
      for (let y = b.length - 1; y >= 0; y--) {
        const s = b.getLine(y)?.translateToString(true) ?? "";
        if (s.startsWith("  " + ${JSON.stringify(second)})) {
          const cell = term._core._renderService.dimensions.css.cell;
          const r = document.querySelector(".xterm-screen").getBoundingClientRect();
          return { x: r.left + 8 * cell.width, y: r.top + (y - b.viewportY + 0.5) * cell.height };
        }
      }
      return null;`);
  const at = await until("wrapped URL printed", rowPos);
  await click(at.x, at.y, { ctrl: true });
  await until("Ctrl+click on its second row takes the whole URL", () =>
    js(`return ${mod("/src/store/app.ts")}.useApp.getState().notices.some((n) => n.message.includes(${JSON.stringify(url)}))`),
  );

  await invoke("terminate_pane", { key: paneKey, force: true });
  log("all link e2e checks passed");
}
