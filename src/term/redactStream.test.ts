import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeRedactor } from "../lib/redact";
import { escEnd, StreamRedactor } from "./redactStream";

const enc = new TextEncoder();
const dec = new TextDecoder();
const r = makeRedactor({ literals: ["consulear"], machines: [] }, "stream");

describe("terminal stream redaction", () => {
  let later: string[];
  let s: StreamRedactor;
  const push = (t: string | Uint8Array) => dec.decode(s.push(typeof t === "string" ? enc.encode(t) : t));

  beforeEach(() => {
    vi.useFakeTimers();
    later = [];
    s = new StreamRedactor(() => r, (b) => later.push(dec.decode(b)));
  });
  afterEach(() => vi.useRealTimers());

  it("masks text and leaves escape sequences alone", () => {
    const out = push("\x1b[1;32mconsulear@box\x1b[0m:~$ \x1b]0;consulear@box\x07ls\r\n");
    expect(out).toBe("\x1b[1;32m•••••••••@box\x1b[0m:~$ \x1b]0;consulear@box\x07ls\r\n");
  });

  it("holds back a secret split across chunks", () => {
    expect(push("hi cons")).toBe("hi ");
    expect(push("ulear!\r\n")).toBe("•••••••••!\r\n");
    // A prefix that goes nowhere is released by the timer.
    expect(push("see con")).toBe("see ");
    vi.advanceTimersByTime(50);
    expect(later).toEqual(["con"]);
  });

  it("doesn't delay ordinary text", () => {
    expect(push("hello there")).toBe("hello there");
    expect(later).toEqual([]);
  });

  it("keeps escape sequences split across chunks intact", () => {
    expect(push("a\x1b[3")).toBe("a");
    expect(push("1mconsulear\x1b[0m")).toBe("\x1b[31m•••••••••\x1b[0m");
  });

  it("copes with UTF-8 split across chunks", () => {
    const bytes = enc.encode("é consulear");
    expect(push(bytes.subarray(0, 1))).toBe("");
    expect(push(bytes.subarray(1))).toBe("é •••••••••");
  });

  it("redacts a whole snapshot without holding anything", () => {
    expect(dec.decode(s.all(enc.encode("\x1b[Hconsulear\r\nx con")))).toBe("\x1b[H•••••••••\r\nx con");
  });

  it("passes everything through when recording is off", () => {
    const off = new StreamRedactor(() => null, () => {});
    expect(dec.decode(off.push(enc.encode("consulear")))).toBe("consulear");
  });

  it("finds where escape sequences end", () => {
    expect(escEnd("\x1b[0m", 0)).toBe(4);
    expect(escEnd("\x1b[0", 0)).toBe(-1);
    expect(escEnd("\x1b]8;;http://x\x1b\\", 0)).toBe(15);
    expect(escEnd("\x1b(B", 0)).toBe(3);
    expect(escEnd("\x1b=", 0)).toBe(2);
    expect(escEnd("\x1b", 0)).toBe(-1);
  });
});
