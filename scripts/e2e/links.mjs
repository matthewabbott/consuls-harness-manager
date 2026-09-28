// End-to-end: Ctrl+clicking `src/App.tsx:42` printed in a terminal opens that file at line 42
// on the pane's machine (a Git Bash pane on This PC, in this repository); a plain click
// doesn't.
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
  const activeFile = () => js(`return ${mod("/src/store/editor.ts")}.useEditor.getState().active`);

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

  await click(pos.x, pos.y);
  await sleep(800);
  if (await activeFile()) throw new Error("a plain click opened the file");
  log("ok   plain click does nothing");

  await click(pos.x, pos.y, { ctrl: true });
  await until("Ctrl+click opens src/App.tsx", async () => ((await activeFile()) ?? "").endsWith("/src/App.tsx"));
  await until("cursor on line 42", () => js(`return (document.querySelector("main footer")?.textContent ?? "").startsWith("Ln 42,")`));

  await js(`const s = ${mod("/src/store/editor.ts")}.useEditor.getState(); s.close(s.active); return true`);
  await invoke("terminate_pane", { key: paneKey, force: true });
  log("all link e2e checks passed");
}
