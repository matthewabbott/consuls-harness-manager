// End-to-end: recording mode masks personal details in the expanded terminal (a PowerShell on
// This PC prints the user name and a tailnet-style IP) and in the app's own text, and shows
// them again when it's switched off. Restores the recording setting it found.
//
//   node scripts/e2e/cdp.mjs scripts/e2e/recording.mjs
import { bufferOf } from "./term.mjs";

export default async function ({ js, text, key, sleep, log }) {
  const buf = (n = 40) => js(bufferOf(n));
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
  const lines = async () => (await buf(60))?.lines ?? [];
  const has = async (s) => (await lines()).some((l) => l.includes(s));
  const invoke = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
  const mod = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;
  const ui = `${mod("ui")}.useUi`;
  const app = `${mod("app")}.useApp`;
  const setRecording = (on) => js(`${ui}.getState().setRecording(${on}); return true`);

  const before = await js(`return ${ui}.getState().recording`);
  const user = await js(`return ${app}.getState().hosts["@local"].facts.user`);
  const home = await js(`return ${app}.getState().hosts["@local"].facts.home`);
  const IP = "100.101.2.3";
  await setRecording(false);

  const key_ = await invoke("create_pane", { spec: { host: "@local", cwd: home, harness: "shell", name: null, session: null, args: null, direct: true, shell: "pwsh" } });
  await js(`${app}.getState().setExpanded(${key_}); return true`);
  try {
    await until("prompt", async () => (await lines()).length > 0, 15000);
    await js(`document.querySelector(".xterm-helper-textarea").focus(); return true`);
    await text(`Write-Output "who=$env:USERNAME ip=${IP}"`);
    await key("Enter");
    await until(`recording off: the user name shows`, () => has(`who=${user} ip=${IP}`));

    await setRecording(true);
    await until("recording on: the snapshot is masked", async () => {
      const l = await lines();
      return l.some((x) => x.includes("who=•")) && !l.some((x) => x.includes(user) || x.includes(IP));
    });
    await until("the app's own text is masked too", () => js(`return !document.querySelector("main header").innerText.includes(${JSON.stringify(user)})`));

    await text(`Write-Output "again=$env:USERNAME"`);
    await key("Enter");
    await until("new output is masked as it arrives", async () => (await lines()).some((x) => x.startsWith("again=•")));
    const masked = (await lines()).find((x) => x.startsWith("again="));
    if (masked !== `again=${"•".repeat([...user].length)}`) throw new Error(`mask keeps the length: ${masked}`);

    await setRecording(false);
    await until("recording off again: shown again", () => has(`again=${user}`));
  } finally {
    await setRecording(before);
    await invoke("terminate_pane", { key: key_, force: true }).catch(() => {});
    await js(`${app}.getState().setExpanded(null); return true`);
    log(`     restored recording mode (${before ? "on" : "off"}) and closed the test shell`);
  }
  log("all recording e2e checks passed");
}
