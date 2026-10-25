// Scrolling full-screen programs with the wheel: the mouse reporting a program asked for, followed
// in its output, and the wheel reports or page keys sent to it.

/** DECSET modes that set how the mouse is reported. */
const TRACKING = [1000, 1002, 1003] as const;
const SGR = 1006;
const UTF8 = 1005;
const MOUSE_MODES = new Set<number>([9, ...TRACKING, 1001, UTF8, SGR, 1015, 1016]);

/**
 * The mouse reporting a program asked for (DECSET 1000/1002/1003 for which events, 1005/1006 for
 * the encoding), as tmux and xterm keep it: setting one tracking mode replaces the others,
 * resetting any of them ends tracking.
 */
export class MouseModes {
  tracking: 0 | (typeof TRACKING)[number] = 0;
  sgr = false;
  utf8 = false;

  /** A `CSI ? Pm h` (`set`) or `l`. Returns whether every mode in it was a mouse mode. */
  apply(params: number[], set: boolean): boolean {
    for (const p of params) {
      if ((TRACKING as readonly number[]).includes(p)) this.tracking = set ? (p as MouseModes["tracking"]) : 0;
      else if (p === SGR) this.sgr = set;
      else if (p === UTF8) this.utf8 = set;
    }
    return params.length > 0 && params.every((p) => MOUSE_MODES.has(p));
  }

  reset() {
    this.tracking = 0;
    this.sgr = false;
    this.utf8 = false;
  }
}

export interface WheelMods {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

/**
 * One wheel report, `up` meaning towards older output, at a 0-based cell, encoded as the program
 * asked: SGR, UTF-8 (sent as text, so the coordinates go out UTF-8 encoded) or the legacy bytes
 * (`binary`: one byte per character). Null when the program takes no mouse, or the cell is out
 * of the legacy encoding's reach.
 */
export function wheelReport(m: MouseModes, up: boolean, col: number, row: number, mods?: WheelMods): { data: string; binary: boolean } | null {
  if (!m.tracking) return null;
  const code = 64 + (up ? 0 : 1) + (mods?.shiftKey ? 4 : 0) + (mods?.altKey ? 8 : 0) + (mods?.ctrlKey ? 16 : 0);
  if (m.sgr) return { data: `\x1b[<${code};${col + 1};${row + 1}M`, binary: false };
  const bytes = [code + 32, col + 33, row + 33];
  if (m.utf8) return bytes[1] > 2047 || bytes[2] > 2047 ? null : { data: "\x1b[M" + String.fromCharCode(...bytes), binary: false };
  return bytes.some((b) => b > 255) ? null : { data: "\x1b[M" + String.fromCharCode(...bytes), binary: true };
}

interface Wheel {
  deltaY: number;
  deltaMode: number;
}

const PIXEL = 0;
const PAGE = 2;

/**
 * Wheel events as steps: lines the way xterm counts them (a trackpad's many small events add up,
 * the fraction carried over), and half screens for programs paged with PgUp/PgDn.
 */
export class WheelSteps {
  private partial = 0;
  private paged = 0;

  /** Whole lines this event scrolls, negative towards older output. */
  lines(ev: Wheel, cellHeight: number, rows: number): number {
    if (ev.deltaY === 0) return 0;
    if (ev.deltaMode === PAGE) return Math.sign(ev.deltaY) * Math.max(1, Math.round(Math.abs(ev.deltaY) * rows));
    let amount = ev.deltaMode === PIXEL ? ev.deltaY / Math.max(1, cellHeight) : ev.deltaY;
    // Small pixel steps are a trackpad's: slow them down, as xterm does.
    if (ev.deltaMode === PIXEL && Math.abs(ev.deltaY) < 50) amount *= 0.3;
    if (Math.sign(amount) !== Math.sign(this.partial)) this.partial = 0; // turned around
    this.partial += amount;
    const whole = Math.trunc(this.partial) || 0;
    this.partial -= whole;
    return whole;
  }

  /** Half screens this event completes, negative towards older output. */
  pages(ev: Wheel, cellHeight: number, rows: number): number {
    if (ev.deltaY === 0) return 0;
    const lines = ev.deltaMode === PIXEL ? ev.deltaY / Math.max(1, cellHeight) : ev.deltaMode === PAGE ? ev.deltaY * rows : ev.deltaY;
    if (Math.sign(lines) !== Math.sign(this.paged)) this.paged = 0;
    this.paged += lines;
    const half = Math.max(1, Math.floor(rows / 2));
    const n = Math.trunc(this.paged / half) || 0;
    this.paged -= n * half;
    return n;
  }
}
