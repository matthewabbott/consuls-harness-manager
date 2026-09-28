// Terminal colours for tiles (and later the expanded xterm theme).

export const theme = {
  background: "#0e1119",
  foreground: "#c9d1e3",
  cursor: "#f5a25d",
  ansi: [
    "#1c2130", "#f07178", "#a6d189", "#e5c07b", "#7aa2f7", "#c792ea", "#7fdbca", "#c9d1e3",
    "#5c6680", "#ff8b92", "#b9e39a", "#f2d38f", "#9ab8ff", "#d7a8f5", "#9eeadb", "#eef1f8",
  ],
};

function build256(): string[] {
  const out = [...theme.ansi];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) out.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(`rgb(${v},${v},${v})`);
  }
  return out;
}

export const palette256 = build256();

/** Decodes the core's colour encoding; `null` means "default". */
export function cssColor(code: number): string | null {
  const tag = code >>> 24;
  if (tag === 1) return palette256[code & 0xff] ?? null;
  if (tag === 2) return `#${(code & 0xffffff).toString(16).padStart(6, "0")}`;
  return null;
}
