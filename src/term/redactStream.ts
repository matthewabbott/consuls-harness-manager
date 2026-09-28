// Recording mode for the expanded terminal: masks secrets in the output before xterm sees it.
// Escape sequences pass through untouched; only printable text between them is matched. Text
// at the end of a chunk that could be the start of a secret (the rest still in flight) is held
// back until the next chunk, or for at most HOLD_MS.
//
// Known limit: a secret drawn in pieces (split by colour changes or cursor moves) isn't seen.

import type { Redactor } from "../lib/redact";

const HOLD_MS = 30;

/** End (exclusive) of the escape sequence starting at `i` (an ESC), or -1 if it's incomplete. */
export function escEnd(s: string, i: number): number {
  if (i + 1 >= s.length) return -1;
  const kind = s[i + 1];
  if (kind === "[") {
    // CSI: parameters and intermediates, then a final byte 0x40–0x7E.
    for (let j = i + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
      if (c < 0x20 || c > 0x3f) return j; // malformed: stop here
    }
    return -1;
  }
  if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
    // OSC / DCS / SOS / PM / APC: up to BEL (OSC) or ST (ESC \).
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b") return j + 1 >= s.length ? -1 : s[j + 1] === "\\" ? j + 2 : j;
    }
    return -1;
  }
  // Charset designation etc.: ESC, an intermediate (0x20–0x2F), one final byte.
  const c = kind.charCodeAt(0);
  if (c >= 0x20 && c <= 0x2f) return i + 2 < s.length ? i + 3 : -1;
  return i + 2;
}

const isControl = (c: number) => c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0);

export class StreamRedactor {
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  /** An unfinished escape sequence, or held-back text. */
  private pending = "";
  private pendingIsText = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `current()` is read on every chunk (secrets can change); null means pass-through. */
  constructor(
    private current: () => Redactor | null,
    private emitLater: (bytes: Uint8Array) => void,
  ) {}

  /** Bytes to show now; anything held back is emitted later through `emitLater`. */
  push(bytes: Uint8Array): Uint8Array {
    if (!this.pending && !this.current()) return bytes;
    clearTimeout(this.timer);
    const s = this.pending + this.decoder.decode(bytes, { stream: true });
    this.pending = "";
    const out = this.scan(s, true);
    if (this.pending) this.timer = setTimeout(() => this.emitLater(this.flush()), HOLD_MS);
    return this.encoder.encode(out);
  }

  /** Everything still held back, redacted. */
  flush(): Uint8Array {
    clearTimeout(this.timer);
    const r = this.current();
    const out = this.pendingIsText && r ? r.text(this.pending) : this.pending;
    this.pending = "";
    return this.encoder.encode(out);
  }

  /** A whole snapshot (RESET): nothing is held back, and state starts fresh. */
  all(bytes: Uint8Array): Uint8Array {
    clearTimeout(this.timer);
    this.pending = "";
    this.decoder = new TextDecoder();
    if (!this.current()) return bytes;
    const s = this.decoder.decode(bytes);
    const out = this.scan(s, false);
    const rest = this.flush();
    return rest.length ? concat(this.encoder.encode(out), rest) : this.encoder.encode(out);
  }

  private scan(s: string, holdTail: boolean): string {
    const r = this.current();
    if (!r) return s;
    let out = "";
    let text = 0; // start of the current run of text
    let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x1b) {
        const end = escEnd(s, i);
        out += r.text(s.slice(text, i));
        if (end < 0) {
          this.pending = s.slice(i);
          this.pendingIsText = false;
          return out;
        }
        out += s.slice(i, end);
        i = text = end;
      } else if (isControl(c)) {
        out += r.text(s.slice(text, i)) + s[i];
        i = text = i + 1;
      } else {
        i++;
      }
    }
    const tail = s.slice(text);
    let cut = tail.length - (holdTail ? r.hold(tail) : 0);
    // Never split a secret that is already complete.
    for (const [a, b] of r.spans(tail)) if (a < cut && cut < b) cut = a;
    this.pending = tail.slice(cut);
    this.pendingIsText = true;
    return out + r.text(tail.slice(0, cut));
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
