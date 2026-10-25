// A pane's labels as small chips, in the labels' order (the phone's agent list).

import { resolveLabels } from "../lib/labels";
import { useApp } from "../store/app";

export default function LabelChips({ ids, className = "" }: { ids: string[]; className?: string }) {
  const defs = useApp((s) => s.config.labels);
  if (ids.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {resolveLabels(ids, defs).map((l) => (
        <span
          key={l.id}
          className={`flex items-center gap-1 rounded-full px-1.5 py-px text-[11.5px] font-medium ${l.unknown ? "text-mist-500" : "text-mist-200"}`}
          style={{ background: `${l.color}22`, boxShadow: `inset 0 0 0 1px ${l.color}55` }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
          {l.name}
        </span>
      ))}
    </div>
  );
}
