// Page-side snippet: in the new-pane dialog, picks "No tmux (plain shell)" when the machine has
// tmux (This PC does, through Cygwin); the shell picker only shows for plain shells.
export const noTmux = `
const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.textContent.includes("No tmux")));
if (!sel || sel.disabled) return false;
const opt = [...sel.options].find((o) => o.textContent.includes("No tmux"));
Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, opt.value);
sel.dispatchEvent(new Event("change", { bubbles: true }));
return true;
`;

// Page-side snippet: finds the xterm Terminal behind the expanded view (via React's fiber
// tree) and returns its size, whether it's on the alternate screen, and the last `n`
// non-empty lines of its buffer.
export function bufferOf(n) {
  return `
const el = document.querySelector(".xterm")?.parentElement;
if (!el) return null;
let f = el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];
let term = null;
while (f && !term) {
  let h = f.memoizedState;
  while (h && !term) {
    const v = h.memoizedState;
    if (v && typeof v === "object" && v.current && v.current.buffer && v.current.cols) term = v.current;
    h = h.next;
  }
  f = f.return;
}
if (!term) return null;
const b = term.buffer.active;
const lines = [];
for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
return { cols: term.cols, rows: term.rows, alt: b.type === "alternate", lines: lines.filter((l) => l.trim()).slice(-${n}) };
`;
}
