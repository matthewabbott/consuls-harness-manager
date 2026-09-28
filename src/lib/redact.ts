// Recording mode: masks personal details (e-mail, tailnet names and IPs, user names, the PC's
// name, optionally machine names) in anything the app shows. Masks keep the text's length —
// in terminals its cell width — so layouts don't shift.

export interface Secrets {
  /** Masked wherever they appear (case-insensitive). */
  literals: string[];
  /** Machines, each by all its names (id, Tailscale host name): shown as "machine 1", … in the
   *  app, masked in terminal text. Empty unless machine names are hidden. */
  machines: string[][];
}

/** How a match is replaced: UI text (machine aliases), tiles (one • per character), or a
 *  terminal stream (one • per cell, so wide characters keep their width). */
export type RedactMode = "ui" | "tile" | "stream";

export interface Redactor {
  text(s: string): string;
  /** [start, end) of each match in `s`. */
  spans(s: string): [number, number][];
  /** How many trailing characters of `s` could be the start of a match still arriving. */
  hold(s: string): number;
}

export const MASK = "•";

const IPV4 = String.raw`(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)`;
const GENERIC = [
  // e-mail (also user@host.domain)
  String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
  // MagicDNS names
  String.raw`[\w-]+(?:\.[\w-]+)*\.ts\.net\b\.?`,
  // tailnet IPv6
  String.raw`fd7a:115c:a1e0(?::[0-9a-f]{0,4}){1,7}`,
  IPV4,
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWide = (cp: number) => cp > 0x2e80;

/** Same-length mask: one • per character, or per cell (`wide`). */
export function maskOf(s: string, wide = false): string {
  let out = "";
  for (const ch of s) out += wide && isWide(ch.codePointAt(0)!) ? MASK + MASK : MASK;
  return out;
}

function realIpv4(s: string): boolean {
  const parts = s.split(".").map(Number);
  // Loopback / "any" addresses say nothing about you.
  return parts.every((n) => n <= 255) && parts[0] !== 127 && s !== "0.0.0.0";
}

export function makeRedactor(secrets: Secrets, mode: RedactMode): Redactor {
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter((x) => x.length >= 3))].sort((a, b) => b.length - a.length);
  const literals = clean(secrets.literals);
  const machines = clean(secrets.machines.flat()).filter((m) => !literals.some((l) => l.toLowerCase() === m.toLowerCase()));
  const alias = new Map<string, string>();
  for (const group of secrets.machines) {
    const names = group.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3);
    const known = names.find((n) => alias.has(n));
    const name = known ? alias.get(known)! : `machine ${new Set(alias.values()).size + 1}`;
    for (const n of names) if (!alias.has(n)) alias.set(n, name);
  }
  const parts = [...GENERIC.map((g) => `(${g})`)];
  parts.push(literals.length ? `(${literals.map(escape).join("|")})` : "(?!)");
  parts.push(machines.length ? `(${machines.map(escape).join("|")})` : "(?!)");
  const re = new RegExp(parts.join("|"), "giu");
  const ipGroup = GENERIC.indexOf(IPV4) + 1;
  const machineGroup = GENERIC.length + 2;

  const keep = (m: RegExpExecArray) => m[ipGroup] !== undefined && !realIpv4(m[0]);
  const replace = (m: RegExpExecArray): string => {
    if (mode === "ui" && m[machineGroup] !== undefined) return alias.get(m[0].toLowerCase()) ?? maskOf(m[0]);
    return maskOf(m[0], mode === "stream");
  };

  const prefixes = [...literals, ...machines].map((x) => x.toLowerCase());
  const longest = Math.max(0, ...prefixes.map((p) => p.length));

  return {
    text(s) {
      if (!s) return s;
      let out = "";
      let last = 0;
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (m[0] === "") {
          re.lastIndex++;
          continue;
        }
        if (keep(m)) continue;
        out += s.slice(last, m.index) + replace(m);
        last = m.index + m[0].length;
      }
      return last === 0 ? s : out + s.slice(last);
    },
    spans(s) {
      const out: [number, number][] = [];
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (m[0] === "") {
          re.lastIndex++;
          continue;
        }
        if (!keep(m)) out.push([m.index, m.index + m[0].length]);
      }
      return out;
    },
    hold(s) {
      let n = 0;
      // A literal (or machine name) that has only started to arrive.
      const tail = s.slice(-Math.max(0, longest - 1)).toLowerCase();
      for (let k = tail.length; k > 0; k--) {
        const suffix = tail.slice(-k);
        if (prefixes.some((p) => p.length > k && p.startsWith(suffix))) {
          n = k;
          break;
        }
      }
      // An IP address, e-mail or MagicDNS name that may continue.
      const partial = s.match(/(?:\d{1,3}\.){0,3}\d{1,3}\.?$|[\w.+-]*@[\w.-]*$|[\w-]+(?:\.[\w-]*)+$/)?.[0] ?? "";
      return Math.max(n, Math.min(partial.length, 80));
    },
  };
}
