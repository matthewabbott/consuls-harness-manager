// Path helpers for the folder browser: POSIX paths on remote machines, and forward-slash
// Windows paths (`C:/Users/…`) on This PC.

const DRIVE = /^[A-Za-z]:/;

/** The root of `path`: `/`, or a drive like `C:/`. */
export function rootOf(path: string): string {
  const m = path.match(DRIVE);
  return m ? `${m[0]}/` : "/";
}

export function isRoot(path: string): boolean {
  return path === rootOf(path) || path === rootOf(path).slice(0, -1);
}

export function parentPath(path: string): string {
  if (isRoot(path)) return rootOf(path);
  const up = path.replace(/\/[^/]+\/?$/, "");
  return up === "" || DRIVE.test(up) && up.length === 2 ? rootOf(path) : up;
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/$/, "")}/${name}`;
}

/** Breadcrumbs for `path`, root first (the root crumb is labelled by its drive, if any). */
export function crumbsOf(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const root = rootOf(path);
  const rest = path.slice(root.length - (root === "/" ? 1 : 0)).replace(/^\//, "");
  const parts = rest.split("/").filter(Boolean);
  const crumbs = parts.map((label, i) => ({ label, path: root + parts.slice(0, i + 1).join("/") }));
  return root === "/" ? crumbs : [{ label: root.slice(0, -1), path: root }, ...crumbs];
}
