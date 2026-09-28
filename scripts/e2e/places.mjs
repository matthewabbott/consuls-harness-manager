// End-to-end: the explorer's places row (drive buttons) and default folders on This PC.
// Restores whatever default folder This PC had before.
//
//   node scripts/e2e/cdp.mjs scripts/e2e/places.mjs

const FOLDER = process.env.FOLDER ?? "D:/a/programming";

export default async function ({ js, sleep, log }) {
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
  const invoke = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
  // The app's own stores (same module instances the UI uses).
  const mod = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;
  const files = `${mod("files")}.useFiles`;
  const app = `${mod("app")}.useApp`;
  const root = () => js(`return ${files}.getState().root?.path ?? null`);
  const chip = (label) => `[...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;

  const drive = FOLDER.slice(0, 2).toUpperCase();
  const drives = await invoke("local_drives");
  log(`     drives: ${drives.map((d) => `${d.label} ${d.kind}${d.volume ? ` "${d.volume}"` : ""}`).join(", ")}`);
  if (!drives.some((d) => d.label === drive)) throw new Error(`${drive} isn't a drive here`);

  const before = await js(`return ${files}.getState().defaults["@local"] ?? null`);
  await js(`${app}.getState().setExpanded(null); return true`);
  await js(`const b = document.querySelector('nav button[title="Files"]'); if (!document.querySelector("aside select")) b.click(); return true`);
  await until("Files panel", () => js(`return !!document.querySelector("aside select")`));
  const home = await js(`return ${app}.getState().hosts["@local"].facts.home`);
  await js(`${files}.getState().setRoot({ host: "@local", path: ${JSON.stringify(home)} }, { follow: false }); return true`);
  await until("home chip lit", () => js(`return document.querySelector('aside button[title^="Home:"]')?.className.includes("bg-sky-400/15")`));

  try {
    await js(`${chip(drive)}.click(); return true`);
    await until(`clicking ${drive} browses ${drive}/`, async () => (await root()) === `${drive}/`);
    await until(`${drive}/ is listed`, () => js(`return document.querySelectorAll("aside [data-path]").length > 0`));
    await until(`${drive} chip lit`, () => js(`return ${chip(drive)}.className.includes("bg-sky-400/15")`));

    // The drive crumb's menu switches drives; back / forward retrace the moves.
    await js(`document.querySelector('aside button[title^="Switch drive"]').click(); return true`);
    await until("drive menu open", () => js(`return document.querySelectorAll("aside .animate-rise button").length >= 2`));
    await js(`[...document.querySelectorAll("aside .animate-rise button")].find((b) => b.innerText.startsWith("C:")).click(); return true`);
    await until("menu switches to C:/", async () => (await root()) === "C:/");
    await js(`document.querySelector('aside button[title^="Back"]').click(); return true`);
    await until(`back returns to ${drive}/`, async () => (await root()) === `${drive}/`);
    await js(`document.querySelector('aside button[title^="Forward"]').click(); return true`);
    await until("forward returns to C:/", async () => (await root()) === "C:/");

    // Double-clicking a folder browses from it.
    const first = FOLDER.slice(3).split("/")[0];
    await js(`${chip(drive)}.click(); return true`);
    await until(`${drive}/ listed again`, () => js(`return !!document.querySelector('aside [data-path$="/${first}"]')`));
    await js(`document.querySelector('aside [data-path$="/${first}"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true`);
    await until(`double-click browses ${drive}/${first}`, async () => (await root())?.toLowerCase() === `${drive}/${first}`.toLowerCase());

    await js(`${files}.getState().setRoot({ host: "@local", path: ${JSON.stringify(FOLDER)} }, { follow: false }); return true`);
    await until(`browsing ${FOLDER}`, async () => (await root())?.toLowerCase() === FOLDER.toLowerCase());
    await js(`document.querySelector('aside button[title^="Make this folder the default"]').click(); return true`);
    const def = await until("star makes it the default", () => js(`return ${files}.getState().defaults["@local"]`));
    await until("default chip shown and lit", () =>
      js(`const b = document.querySelector('aside button[title^="Default folder on This PC"]'); return !!b && b.className.includes("bg-sky-400/15")`),
    );
    await until("default persisted", () => js(`return (localStorage.getItem("consuls.files.v1") ?? "").includes(${JSON.stringify(def)})`));

    // Like a fresh start: nothing to follow, no root → the explorer opens at the default.
    await js(`${chip("C:")}.click(); return true`);
    await until("moved away (C:/)", async () => (await root()) === "C:/");
    await js(`${files}.getState().setRoot(null); return true`);
    await until("explorer starts at the default", async () => (await root()) === def);

    // The new-pane dialog starts there too.
    await js(`${app}.getState().openNewPane("@local"); return true`);
    await until("new-pane dialog starts at the default", () => js(`return document.querySelector("form input")?.value === ${JSON.stringify(def)}`));
    await js(`${app}.getState().closeNewPane(); return true`);

    // The star clears it again.
    await js(`document.querySelector('aside button[title^="This is the default folder"]').click(); return true`);
    await until("star clears the default", () => js(`return !${files}.getState().defaults["@local"]`));
  } finally {
    await js(`${files}.getState().setDefault("@local", ${JSON.stringify(before)}); return true`);
    log(`     restored This PC's default folder (${before ?? "none"})`);
  }
  log("all places e2e checks passed");
}
