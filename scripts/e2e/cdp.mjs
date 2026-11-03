// Drives the running desktop app's WebView over the Chrome DevTools Protocol, for end-to-end
// checks of the real UI against real machines. Start the app with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./target/debug/consuls.exe
// then:
//   node scripts/e2e/cdp.mjs <steps.mjs> [port]
// The steps module default-exports an async function({ js, text, key, click, sleep, log }).
// It runs in the window labelled $WINDOW ("main" by default; extra windows are "win-N"), which
// is put on the grid first (the layout is restored at launch, so the app may start in a split).
import { pathToFileURL } from "node:url";

const [, , file, port = "9333"] = process.argv;
const want = process.env.WINDOW || "main";

/** A DevTools connection to one page: `call(method, params)` and `close()`. */
async function connect(url) {
  const ws = new WebSocket(url);
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
  return { call, close: () => ws.close() };
}

// Every window loads the same page with the same title: ask each for its Tauri label.
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
if (!targets.length) throw new Error("no page target");
let conn = null;
const seen = [];
for (const t of targets) {
  const c = await connect(t.webSocketDebuggerUrl);
  const res = await c.call("Runtime.evaluate", { expression: "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null", returnByValue: true });
  const label = res.result?.result?.value ?? null;
  seen.push(label);
  // An app too old to say which window it is has just the one that counts.
  if (label === want || (label === null && !conn && targets.length === 1)) {
    conn = c;
    break;
  }
  c.close();
}
if (!conn) throw new Error(`no window "${want}" (found: ${JSON.stringify(seen)})`);
const { call } = conn;

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
  End: { code: "End", vk: 35 },
  Home: { code: "Home", vk: 36 },
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
/** A real mouse click at page coordinates: hover first (xterm links need it), then press/release. */
const click = async (x, y, mods = {}) => {
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  await sleep(150);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers });
};

/** A store module of the app (debug builds serve them by path), e.g. `${store("layout")}.useLayout`. */
const store = (name) => `(await import(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/src/store/${name}.ts")).pop() ?? "/src/store/${name}.ts"))`;

const steps = (await import(pathToFileURL(file).href)).default;
try {
  // Scripts start on the grid with the sidebar showing, as the app did before layouts were kept.
  await js(`${store("layout")}.useLayout.getState().toGrid(); ${store("ui")}.useUi.setState({ maximized: false }); return true`);
  await steps({ js, text, key, click, sleep, log });
} catch (e) {
  console.log("FAILED:", e.message);
  process.exitCode = 1;
}
conn.close();
