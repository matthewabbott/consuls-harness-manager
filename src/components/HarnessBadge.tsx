import type { Harness } from "../ipc/bindings/Harness";

const META: Record<Harness, { glyph: string; label: string; cls: string }> = {
  claude: { glyph: "✳", label: "Claude Code", cls: "bg-claude/15 text-claude ring-claude/30" },
  codex: { glyph: "◎", label: "Codex", cls: "bg-codex/10 text-codex ring-codex/25" },
  omp: { glyph: "π", label: "omp", cls: "bg-omp/15 text-omp ring-omp/30" },
  pi: { glyph: "π", label: "pi", cls: "bg-pi/15 text-pi ring-pi/30" },
  opencode: { glyph: "◇", label: "opencode", cls: "bg-opencode/15 text-opencode ring-opencode/30" },
  gemini: { glyph: "✦", label: "Gemini", cls: "bg-gemini/15 text-gemini ring-gemini/30" },
  shell: { glyph: "$", label: "Shell", cls: "bg-ink-600/60 text-mist-300 ring-ink-500" },
};

export function harnessLabel(h: Harness | null): string {
  return h ? META[h].label : "Process";
}

export function isAgent(h: Harness | null): boolean {
  return h !== null && h !== "shell";
}

export default function HarnessBadge({ harness, size = 22 }: { harness: Harness | null; size?: number }) {
  const meta = harness ? META[harness] : { glyph: "›", label: "Process", cls: "bg-ink-600/60 text-mist-400 ring-ink-500" };
  return (
    <span
      title={meta.label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-mono font-semibold ring-1 ring-inset ${meta.cls}`}
      style={{ width: size, height: size, fontSize: size * 0.58 }}
    >
      {meta.glyph}
    </span>
  );
}
