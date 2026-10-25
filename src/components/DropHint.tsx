import type { Edge } from "../lib/layoutTree";

const AREA: Record<Edge, React.CSSProperties> = {
  left: { left: 0, top: 0, width: "50%", height: "100%" },
  right: { right: 0, top: 0, width: "50%", height: "100%" },
  top: { left: 0, top: 0, width: "100%", height: "50%" },
  bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
  center: { inset: 0 },
};

/** Where a dragged tile would land: the half (or the whole) of the box it's over. */
export default function DropHint({ edge }: { edge: Edge }) {
  return <div className="pointer-events-none absolute z-20 rounded-xl bg-sky-400/15 ring-2 ring-sky-400/60" style={AREA[edge]} />;
}
