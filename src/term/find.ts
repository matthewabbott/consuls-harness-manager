// Finding text: the colours xterm's search add-on paints matches in (desktop and phone), and the
// same search over plain text for the phone's copy view.

export const MATCH_DECORATIONS = {
  matchBackground: "#6aa9ff40",
  matchBorder: "#6aa9ff80",
  matchOverviewRuler: "#6aa9ff",
  activeMatchBackground: "#f5a25d",
  activeMatchBorder: "#ffc27f",
  activeMatchColorOverviewRuler: "#f5a25d",
};

/** Where `query` occurs in `text` (case-insensitive, taken literally), as [start, end) offsets. */
export function findAll(text: string, query: string): [number, number][] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return Array.from(text.matchAll(pattern), (m) => [m.index, m.index + m[0].length]);
}
