// Drives the running desktop app's WebView over the Chrome DevTools Protocol, for end-to-end
// checks of the real UI against real machines. Start the app with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./target/debug/consuls.exe
// then:
//   node scripts/e2e/cdp.mjs <steps.mjs> [port]
// The steps module default-exports an async function({ js, text, key, sleep, log }).
import { pathToFileURL } from "node:url";

const [, , file, port = "9333"] = process.argv;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target: " + JSON.stringify(targets));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const call = (method, params) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const js = async (expr) => {
  const res = await call("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, timeout: 60000 });
  if (res.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(res.result.exceptionDetails).slice(0, 1500));
  return res.result?.result?.value;
};
const text = (t) => call("Input.insertText", { text: t });
const KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  Tab: { code: "Tab", vk: 9, text: "\t" },
};
/** key("Enter"), key("c", { ctrl: true }), key("d") … */
const key = async (name, mods = {}) => {
  const k = KEYS[name] ?? { key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name };
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
  const base = { key: k.key ?? name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
  const txt = mods.ctrl ? undefined : k.text;
  await call("Input.dispatchKeyEvent", { type: txt ? "keyDown" : "rawKeyDown", ...base, ...(txt ? { text: txt, unmodifiedText: txt } : {}) });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const steps = (await import(pathToFileURL(file).href)).default;
try {
  await steps({ js, text, key, sleep, log });
} catch (e) {
  console.log("FAILED:", e.message);
  process.exitCode = 1;
}
ws.close();
