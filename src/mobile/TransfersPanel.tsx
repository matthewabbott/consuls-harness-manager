// Uploads and downloads under way, at the bottom of the file browser and the viewer. A finished
// download waits here for "Save…" (the share sheet needs a tap of its own).

import { Check, Download, RotateCcw, Share, Upload, X } from "lucide-react";

import { fmtSize } from "../lib/sizes";
import { cancel, retry, save, type Transfer, useTransfers } from "./files";

export default function TransfersPanel() {
  const list = useTransfers((s) => s.list);
  if (list.length === 0) return null;
  return (
    <div className="safe-bottom max-h-56 shrink-0 overflow-y-auto border-t border-ink-700/80 bg-ink-850 px-2 pt-1.5">
      {list.map((t) => (
        <Row key={t.id} t={t} />
      ))}
    </div>
  );
}

function Row({ t }: { t: Transfer }) {
  const up = t.kind === "upload";
  const pct = t.total > 0 ? Math.min(100, (t.done / t.total) * 100) : t.state === "ready" ? 100 : 0;
  const status =
    t.state === "queued"
      ? "Waiting…"
      : t.state === "running"
        ? t.total > 0
          ? `${fmtSize(t.done)} of ${fmtSize(t.total)}`
          : fmtSize(t.done)
        : t.state === "failed"
          ? t.error
          : up
            ? "Uploaded"
            : "Ready to save";
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className={`shrink-0 ${t.state === "failed" ? "text-rose-400" : "text-mist-400"}`}>
        {t.state === "ready" && up ? <Check className="h-4.5 w-4.5 text-jade-400" /> : up ? <Upload className="h-4.5 w-4.5" /> : <Download className="h-4.5 w-4.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="personal truncate text-[14px] text-mist-100">{t.name}</div>
        <div className={`truncate text-[12px] ${t.state === "failed" ? "text-rose-300" : "text-mist-500"}`}>{status}</div>
        {(t.state === "running" || t.state === "queued") && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-sky-400 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {t.state === "ready" && !up && (
        <button onClick={() => save(t)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-ember-400 px-3 py-1.5 text-[14px] font-semibold text-ink-950 active:opacity-80">
          <Share className="h-4 w-4" /> Save…
        </button>
      )}
      {t.state === "failed" && up && t.source && (
        <button onClick={() => retry(t.id)} aria-label="Try again" className="shrink-0 rounded-full p-2 text-mist-200 active:bg-ink-700">
          <RotateCcw className="h-4.5 w-4.5" />
        </button>
      )}
      {!(t.state === "ready" && up) && (
        <button onClick={() => cancel(t)} aria-label={t.state === "running" || t.state === "queued" ? "Cancel" : "Dismiss"} className="shrink-0 rounded-full p-2 text-mist-500 active:bg-ink-700">
          <X className="h-4.5 w-4.5" />
        </button>
      )}
    </div>
  );
}
