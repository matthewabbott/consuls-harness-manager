import { Check, Loader2, Minus, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { backend } from "../ipc/backend";
import type { IntegrationStatus } from "../ipc/bindings/IntegrationStatus";
import type { ToolStatus } from "../ipc/bindings/ToolStatus";
import { useApp } from "../store/app";
import HarnessBadge from "./HarnessBadge";
import Modal, { Button } from "./Modal";

const TOOLS: { id: "claude" | "codex" | "omp"; label: string; what: string }[] = [
  { id: "claude", label: "Claude Code", what: "Adds hook entries to ~/.claude/settings.json (backed up first)." },
  { id: "codex", label: "Codex", what: "Sets notify in ~/.codex/config.toml, unless you already use one." },
  { id: "omp", label: "omp", what: "Adds ~/.omp/agent/hooks/post/consuls.ts, which omp loads automatically." },
];

function StatusPill({ status }: { status: ToolStatus }) {
  const map: Record<ToolStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    installed: { label: "Installed", cls: "bg-jade-400/15 text-jade-400 ring-jade-400/30", icon: <Check className="h-3 w-3" /> },
    notInstalled: { label: "Not installed", cls: "bg-ink-700 text-mist-300 ring-ink-600", icon: <Minus className="h-3 w-3" /> },
    absent: { label: "Not used on this machine", cls: "bg-ink-800 text-mist-500 ring-ink-700", icon: <Minus className="h-3 w-3" /> },
    conflict: { label: "Has its own notify", cls: "bg-ember-400/15 text-ember-300 ring-ember-400/30", icon: <TriangleAlert className="h-3 w-3" /> },
  };
  const m = map[status];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${m.cls}`}>{m.icon}{m.label}</span>;
}

export default function IntegrationDialog({ host }: { host: string }) {
  const close = () => useApp.getState().setIntegrationFor(null);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    backend()
      .then((b) => b.integrationStatus(host))
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, [host]);

  const run = async (action: "install" | "uninstall") => {
    setBusy(action);
    setError(null);
    try {
      const b = await backend();
      setStatus(action === "install" ? await b.installIntegration(host) : await b.uninstallIntegration(host));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const anyInstalled = status && TOOLS.some((t) => status[t.id] === "installed");
  const anyInstallable = status && TOOLS.some((t) => status[t.id] === "notInstalled");

  return (
    <Modal
      title={`Notifications for agents started outside Consuls · ${host}`}
      onClose={close}
      width={560}
      footer={
        <>
          {error && <span className="mr-auto truncate text-[12px] text-rose-400">{error}</span>}
          {anyInstalled && (
            <Button onClick={() => run("uninstall")} disabled={busy !== null}>
              {busy === "uninstall" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Remove
            </Button>
          )}
          <Button kind="primary" onClick={() => run("install")} disabled={busy !== null || !anyInstallable}>
            {busy === "install" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Install
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-mist-300">
        Agents you launch from Consuls always report when they finish or need you. To get the same for sessions you start by hand in
        tmux, Consuls can add a tiny hook to each harness's config on <span className="font-mono text-mist-100">{host}</span>. The hook
        only records an event when it runs inside tmux, never prints anything, and can be removed here at any time.
      </p>
      <div className="mt-4 space-y-2">
        {TOOLS.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-xl bg-ink-850 px-3.5 py-3 ring-1 ring-ink-700">
            <HarnessBadge harness={t.id} size={24} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-mist-100">{t.label}</div>
              <div className="text-[11.5px] text-mist-500">{t.what}</div>
            </div>
            {status ? <StatusPill status={status[t.id]} /> : <Loader2 className="h-4 w-4 animate-spin text-mist-500" />}
          </div>
        ))}
      </div>
      {status && status.notes.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl bg-ink-900/60 px-3.5 py-2.5 text-[12px] text-mist-300 ring-1 ring-ink-700">
          {status.notes.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
