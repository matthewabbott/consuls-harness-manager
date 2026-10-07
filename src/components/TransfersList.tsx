// Uploads and downloads under way, under the explorer: progress, cancel, and where a download
// landed (shown in Finder / File Explorer).

import { Check, Download, FolderSearch, Upload, X } from "lucide-react";

import { LOCAL_HOST } from "../lib/hosts";
import { REVEAL_LABEL, revealPath } from "../lib/openers";
import { fmtSize } from "../lib/sizes";
import { useRedact } from "../store/recording";
import { cancel, dismiss, type Transfer, useTransfers } from "../store/transfers";

export default function TransfersList() {
  const list = useTransfers((s) => s.list);
  if (list.length === 0) return null;
  return (
    <div className="scroll-thin max-h-44 shrink-0 overflow-y-auto border-t border-ink-700 px-2 py-1.5">
      {list.map((t) => (
        <Row key={t.id} t={t} />
      ))}
    </div>
  );
}

function Row({ t }: { t: Transfer }) {
  const r = useRedact();
  const pct = t.total > 0 ? Math.min(100, (t.done / t.total) * 100) : 0;
  const live = t.state === "queued" || t.state === "running";
  const status =
    t.state === "queued"
      ? "Waiting…"
      : t.state === "running"
        ? `${fmtSize(t.done)} of ${fmtSize(t.total)}`
        : t.state === "failed"
          ? t.error
          : t.upload
            ? "Uploaded"
            : "Downloaded";
  return (
    <div className="flex items-center gap-2 py-1" title={r(t.path ?? t.name)}>
      <span className={`shrink-0 ${t.state === "failed" ? "text-rose-400" : "text-mist-500"}`}>
        {t.state === "done" ? <Check className="h-3.5 w-3.5 text-jade-400" /> : t.upload ? <Upload className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-mist-200">{r(t.name)}</div>
        <div className={`truncate text-[10.5px] ${t.state === "failed" ? "text-rose-300" : "text-mist-500"}`}>{status}</div>
        {live && (
          <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-sky-400 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {t.state === "done" && !t.upload && t.path && (
        <button onClick={() => revealPath(LOCAL_HOST, t.path!)} title={REVEAL_LABEL} className="shrink-0 rounded p-1 text-mist-400 hover:bg-ink-700 hover:text-mist-100">
          <FolderSearch className="h-3.5 w-3.5" />
        </button>
      )}
      {!(t.state === "done" && t.upload) && (
        <button
          onClick={() => (live ? cancel(t) : dismiss(t.id))}
          title={live ? "Cancel" : "Dismiss"}
          className="shrink-0 rounded p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
