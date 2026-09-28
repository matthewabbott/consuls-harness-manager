import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";

import { useApp, type Notice } from "../store/app";
import { useRedact } from "../store/recording";

function NoticeCard({ n }: { n: Notice }) {
  const dismiss = useApp((s) => s.dismiss);
  const r = useRedact();
  useEffect(() => {
    if (n.level === "error") return;
    const t = setTimeout(() => dismiss(n.id), n.level === "warning" ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [n, dismiss]);
  const icon =
    n.level === "error" ? (
      <CircleAlert className="h-4 w-4 text-rose-400" />
    ) : n.level === "warning" ? (
      <TriangleAlert className="h-4 w-4 text-ember-400" />
    ) : (
      <Info className="h-4 w-4 text-sky-400" />
    );
  return (
    <div className="animate-rise pointer-events-auto flex w-96 items-start gap-2.5 rounded-xl bg-ink-800/95 px-3.5 py-3 shadow-2xl ring-1 ring-ink-600 backdrop-blur">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-mist-200">
        {n.host && <span className="font-semibold text-mist-100">{r(n.host)}: </span>}
        {r(n.message)}
      </div>
      <button onClick={() => dismiss(n.id)} className="text-mist-500 hover:text-mist-200">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function Notices() {
  const notices = useApp((s) => s.notices);
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex flex-col gap-2">
      {notices.map((n) => (
        <NoticeCard key={n.id} n={n} />
      ))}
    </div>
  );
}
