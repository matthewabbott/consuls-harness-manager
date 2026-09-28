import { useEffect, useState } from "react";

export interface Size {
  width: number;
  height: number;
}

/**
 * The element's size, updated only once it has stopped changing for `quietMs` (and after any
 * CSS transition on the element ends). Used to decide when to resize remote terminals, where
 * every intermediate size would cost a full redraw on the other end.
 */
export function useSettledSize(ref: React.RefObject<HTMLElement | null>, quietMs = 200): Size | null {
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    const commit = () => {
      const rect = el.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(commit, quietMs);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    el.addEventListener("transitionend", commit);
    commit();
    return () => {
      ro.disconnect();
      el.removeEventListener("transitionend", commit);
      window.clearTimeout(timer);
    };
  }, [ref, quietMs]);

  return size;
}
