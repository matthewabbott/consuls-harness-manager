// Moving one item of a list to another place in it by dragging: which gap a drop lands in,
// and the order that makes.

/** A row's vertical extent on screen. */
export interface Span {
  top: number;
  bottom: number;
}

/** The gap a drop at `y` lands in: 0 before the first row, … `rows.length` after the last. */
export function dropGap(y: number, rows: Span[]): number {
  const i = rows.findIndex((r) => y < (r.top + r.bottom) / 2);
  return i === -1 ? rows.length : i;
}

/** Whether dropping `id` into `gap` changes the order (the gaps either side of it don't). */
export function movesIt<T>(ids: T[], id: T, gap: number): boolean {
  const from = ids.indexOf(id);
  return from !== -1 && gap !== from && gap !== from + 1;
}

/** `ids` with `id` moved into `gap` (counted in `ids` as it is). */
export function moveToGap<T>(ids: T[], id: T, gap: number): T[] {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  const out = ids.filter((x) => x !== id);
  out.splice(gap > from ? gap - 1 : gap, 0, id);
  return out;
}
