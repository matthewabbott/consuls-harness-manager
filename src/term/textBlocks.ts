// A pane's output as blocks to copy one at a time on a phone (selecting in a terminal by touch
// is hard): each agent message, tool call and prompt of yours, cut where the agent's TUI starts
// one (`⏺ ` in Claude Code, `• ` in Codex, `> ` / `› ` for what you sent), each turned back into
// the text it meant (smartCopy).

import { type Row, smartCopy } from "./smartCopy";

export type BlockKind = "you" | "agent" | "tool" | "output";

export interface TextBlock {
  kind: BlockKind;
  text: string;
}

const AGENT = /^[⏺●] /u;
const CODEX = /^• /u;
const YOU = /^[>›] /u;
/**
 * The agent's own furniture, not output: Claude Code's input box (a rounded `╭` corner; tables in
 * messages use square ones) or the rule drawn around it, and its status lines after.
 */
const CHROME = /^\s*╭|^\s*─{10,}\s*$/u;
/** `⏺ Bash(…)`, `⏺ Read(…)`: a tool call, not a message. */
const CLAUDE_TOOL = /^[⏺●] [A-Z][\w-]*\(/u;
const CODEX_TOOL = /^• (Ran|Explored|Edited|Read|Updated|Added|Deleted|Searched|Listed|Called|Waited)\b/u;

function kindOf(line: string): BlockKind | null {
  if (YOU.test(line)) return "you";
  if (CLAUDE_TOOL.test(line) || CODEX_TOOL.test(line)) return "tool";
  if (AGENT.test(line) || CODEX.test(line)) return "agent";
  return null;
}

export function splitBlocks(rows: Row[], cols: number): TextBlock[] {
  const blocks: { kind: BlockKind | "chrome"; rows: Row[] }[] = [];
  for (const row of rows) {
    // A block starts on a row of its own (not a soft-wrapped continuation).
    const kind = row.wrapped ? null : CHROME.test(row.text) ? "chrome" : kindOf(row.text);
    if (kind || blocks.length === 0) blocks.push({ kind: kind ?? "output", rows: [] });
    blocks[blocks.length - 1].rows.push(row);
  }
  return blocks
    .filter((b): b is { kind: BlockKind; rows: Row[] } => b.kind !== "chrome")
    .map((b) => ({ kind: b.kind, text: (b.kind === "you" ? b.rows.map((r) => ({ ...r, text: r.text.replace(YOU, "  ") })) : b.rows) }))
    .map((b) => ({ kind: b.kind, text: smartCopy(b.text, cols) }))
    .filter((b) => b.text.trim() !== "");
}

/** The rows of an xterm buffer (or the last `limit` of them), for splitBlocks. */
export function bufferRows(
  buffer: { length: number; getLine(y: number): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined },
  limit = Infinity,
): Row[] {
  const rows: Row[] = [];
  for (let y = Math.max(0, buffer.length - limit); y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
  }
  // A block cut at the limit may start mid-row: drop a leading continuation.
  while (rows.length && rows[0].wrapped) rows.shift();
  return rows;
}
