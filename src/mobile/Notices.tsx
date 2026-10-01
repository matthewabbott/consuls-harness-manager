import { X } from "lucide-react";
import { useEffect } from "react";

import { useApp, type Notice } from "../store/app";

const TONE: Record<Notice["level"], string> = {
  error: "text-rose-300 ring-rose-400/40",
  warning: "text-ember-300 ring-ember-400/40",
  info: "text-mist-200 ring-ink-600",
};

function Card({ n }: { n: Notice }) {
  const dismiss = useApp((s) => s.dismiss);
  useEffect(() => {
    if (n.level === "error") return;
    const t = setTimeout(() => dismiss(n.id), n.level === "warning" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [n, dismiss]);
  return (
    <div className={`pointer-events-auto flex items-start gap-2 rounded-2xl bg-ink-800/95 px-3.5 py-2.5 shadow-2xl ring-1 backdrop-blur ${TONE[n.level]}`}>
      <div className="min-w-0 flex-1 text-[13.5px] leading-snug">
        {n.host && <span className="font-semibold">{n.host}: </span>}
        {n.message}
      </div>
      <button onClick={() => dismiss(n.id)} aria-label="Dismiss" className="-m-1 p-1 text-mist-400">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The core's notices, at the top (the keyboard covers the bottom). */
export default function Notices() {
  const notices = useApp((s) => s.notices);
  return (
    <div className="safe-top pointer-events-none fixed inset-x-3 top-0 z-50 flex flex-col gap-2">
      {notices.slice(-3).map((n) => (
        <Card key={n.id} n={n} />
      ))}
    </div>
  );
}
