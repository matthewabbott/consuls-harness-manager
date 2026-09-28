import { Tag } from "lucide-react";

import { useApp } from "../store/app";
import { useDrag } from "../store/drag";

/** Floating chip that follows the pointer while a tile is dragged onto a label. */
export default function DragGhost() {
  const key = useDrag((s) => s.key);
  const title = useDrag((s) => s.title);
  const x = useDrag((s) => s.x);
  const y = useDrag((s) => s.y);
  const over = useDrag((s) => s.over);
  const overName = useApp((s) => s.config.labels.find((l) => l.id === over)?.name);
  if (key === null) return null;
  return (
    <div
      className={`pointer-events-none fixed z-[60] flex max-w-60 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium shadow-2xl ring-1 ${
        over ? "bg-sky-400/90 text-ink-950 ring-sky-300" : "bg-ink-700/95 text-mist-100 ring-ink-500"
      }`}
      style={{ left: x + 12, top: y + 8 }}
    >
      <Tag className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{overName ? `Tag as ${overName}` : title}</span>
    </div>
  );
}
