// Finding file references in terminal output (`src/App.tsx:42`, `./lib.rs:10:5`,
// `C:\code\main.py(3,1)`) and resolving them against the pane's working directory.

export interface PathRef {
  /** Where the reference starts in the line (0-based char index) and its length. */
  index: number;
  length: number;
  path: string;
  line?: number;
  col?: number;
}

const KNOWN_EXT = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx rs py pyi go rb java kt kts swift c h cc cpp hpp cs fs toml yaml yml sh bash zsh fish ps1 " +
    "txt log html htm css scss sass less sql lua php vue svelte ex exs erl hrl hs ml mli nix lock cfg ini conf xml gradle proto graphql " +
    "dart scala clj cljs r jl zig nim tf hcl env csv tsv ipynb"
  ).split(" "),
);

// An optional ~ / ./ / ../ / drive prefix, path segments, a name with an extension, then an
// optional :line[:col] or (line[,col]).
const PATH_RE =
  /(?<![\w/\\.~@-])((?:~|\.{1,2})?(?:[A-Za-z]:)?[\\/]?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.([A-Za-z0-9_]+))(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** File references in one line of terminal text. */
export function findPaths(text: string): PathRef[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const out: PathRef[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const index = m.index!;
    if (urls.some(([a, b]) => index >= a && index < b)) continue; // part of a URL
    const [whole, path, ext] = m;
    const line = m[3] ?? m[5];
    const col = m[4] ?? m[6];
    const hasSep = /[\\/]/.test(path);
    if (!hasSep && !line && !KNOWN_EXT.has(ext.toLowerCase())) continue;
    // Trailing sentence punctuation isn't part of the name.
    const trimmed = whole.replace(/[.,;:]+$/, "");
    out.push({
      index,
      length: trimmed.length,
      path: path.replace(/[.,;:]+$/, ""),
      line: line ? Number(line) : undefined,
      col: col ? Number(col) : undefined,
    });
  }
  return out;
}

/** Resolves `.` and `..` segments (keeps a leading `/` or `C:/`). */
export function normalizePath(p: string): string {
  const drive = p.match(/^[A-Za-z]:/)?.[0] ?? "";
  const rest = p.slice(drive.length);
  const abs = rest.startsWith("/");
  const parts: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `${drive}${abs ? "/" : ""}${parts.join("/")}`;
}

/** Absolute path for a reference printed in a pane whose working directory is `cwd`. */
export function resolvePath(ref: string, cwd: string, home?: string | null): string {
  const p = ref.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) return normalizePath(p);
  if (p.startsWith("~/") && home) return normalizePath(`${home}/${p.slice(2)}`);
  return normalizePath(`${cwd}/${p}`);
}
