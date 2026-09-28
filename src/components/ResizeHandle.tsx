import { useRef } from "react";

interface Props {
  /** "x" drags horizontally (a vertical splitter), "y" vertically. */
  axis: "x" | "y";
  /** Current size of the panel being resized. */
  size: number;
  /** +1 if dragging right/down grows the panel, -1 if it shrinks it. */
  direction: 1 | -1;
  onResize(size: number): void;
  /** Called once when the drag ends (e.g. to trigger a layout-settled refit). */
  onResizeEnd?(): void;
  /** Double-click restores this size. */
  resetTo?: number;
  className?: string;
}

/** A thin draggable splitter using pointer capture (works over iframes/canvases). */
export default function ResizeHandle({ axis, size, direction, onResize, onResizeEnd, resetTo, className = "" }: Props) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const horizontal = axis === "x";

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        e.preventDefault();
        capture(e.target, e.pointerId);
        start.current = { pos: horizontal ? e.clientX : e.clientY, size };
        document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = (horizontal ? e.clientX : e.clientY) - start.current.pos;
        onResize(start.current.size + delta * direction);
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        release(e.target, e.pointerId);
        start.current = null;
        document.body.style.cursor = "";
        onResizeEnd?.();
      }}
      onDoubleClick={() => {
        if (resetTo !== undefined) {
          onResize(resetTo);
          onResizeEnd?.();
        }
      }}
      className={`group relative z-10 shrink-0 ${horizontal ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"} ${className}`}
    >
      <div
        className={`absolute rounded-full bg-sky-400/0 transition-colors group-hover:bg-sky-400/50 ${
          horizontal ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2" : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2"
        }`}
      />
    </div>
  );
}

/** Pointer capture keeps the drag alive outside the element; harmless if unavailable. */
function capture(target: EventTarget, id: number) {
  try {
    (target as HTMLElement).setPointerCapture(id);
  } catch {
    /* synthetic or already-released pointer */
  }
}

function release(target: EventTarget, id: number) {
  try {
    (target as HTMLElement).releasePointerCapture(id);
  } catch {
    /* not captured */
  }
}
