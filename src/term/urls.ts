// URLs that a program hard-wrapped across rows (Claude Code prints its sign-in link that way):
// putting them back together for copying and Ctrl+click. Without this, a copied or clicked
// link stops at the first wrap ("Missing redirect_uri parameter").

/** A row ending this close to the right edge may continue on the next one. */
export const EDGE_SLACK = 8;

const SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
const URL_TOKEN = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * Whether `next` carries on a URL: `row` (the previous row, trailing spaces trimmed) ran up to
 * the right edge, the text so far (`soFar`, which may span several rows) ends in a URL, and
 * `next` starts with URL characters: with digits or URL punctuation, or as a long row with no
 * spaces. A plain word after a URL that happened to end at the edge is prose, not more URL.
 */
export function continuesUrl(row: string, soFar: string, next: string, cols: number): boolean {
  if (row.length < cols - EDGE_SLACK) return false;
  const tail = soFar.match(/\S+$/)?.[0] ?? "";
  if (!SCHEME.test(tail)) return false;
  const head = next.trimStart().match(/^\S+/)?.[0] ?? "";
  if (!URL_TOKEN.test(head)) return false;
  return /[/?#=&%:~_\d-]/.test(head) || (head.length >= 20 && next.trim() === head);
}

export interface RowText {
  text: string;
  /** The terminal soft-wrapped this row onto the previous one. */
  wrapped: boolean;
}

export interface UrlSpan {
  url: string;
  /** First and last cell (0-based rows and columns, both inclusive). */
  start: { row: number; col: number };
  end: { row: number; col: number };
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]}]/gi;

export type Cell = { row: number; col: number };

/**
 * A run of rows read as texts: rows the terminal soft-wrapped join the one before, and so do
 * rows `glue` says carry on a hard-wrapped token (`glue(prevRow, soFar, row)`); each text comes
 * with every character's cell.
 */
export function joinRows(rows: RowText[], glue: (prev: string, soFar: string, next: string) => boolean): { text: string; at: Cell[] }[] {
  const out: { text: string; at: Cell[] }[] = [];
  let text = "";
  let at: Cell[] = [];
  const flush = () => {
    if (text) out.push({ text, at });
    text = "";
    at = [];
  };
  rows.forEach((r, row) => {
    const prev = row > 0 ? rows[row - 1].text.trimEnd() : "";
    const glued = row > 0 && !r.wrapped && glue(prev, text.trimEnd(), r.text);
    if (row > 0 && !r.wrapped && !glued) flush();
    let col = 0;
    let body = r.text;
    if (glued) {
      text = text.trimEnd();
      at.length = text.length;
      col = r.text.length - r.text.trimStart().length;
      body = r.text.trimStart();
    }
    // One entry per UTF-16 unit, matching regexes' indexes.
    for (let i = 0; i < body.length; i++) {
      text += body[i];
      at.push({ row, col });
      col += 1;
    }
  });
  flush();
  return out;
}

/** http(s) URLs in a run of rows, following soft wraps and hard-wrapped URLs. */
export function findUrls(rows: RowText[], cols: number): UrlSpan[] {
  return joinRows(rows, (prev, soFar, next) => continuesUrl(prev, soFar, next, cols)).flatMap(({ text, at }) =>
    [...text.matchAll(URL_RE)].map((m) => ({ url: m[0], start: at[m.index!], end: at[m.index! + m[0].length - 1] })),
  );
}
