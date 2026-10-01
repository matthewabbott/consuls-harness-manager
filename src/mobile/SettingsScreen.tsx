import { ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";

import { backend, inWebApp } from "../ipc/backend";
import { phaseText } from "../lib/agents";
import { useApp } from "../store/app";
import NotificationSettings from "./NotificationSettings";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-1.5 px-1 text-[12px] font-medium tracking-wide text-mist-500 uppercase">{title}</h2>
      <div className="divide-y divide-ink-700 rounded-2xl bg-ink-800 ring-1 ring-ink-700">{children}</div>
    </section>
  );
}

export default function SettingsScreen({ onBack, onAdd }: { onBack(): void; onAdd(): void }) {
  const config = useApp((s) => s.config);
  const hosts = useApp((s) => s.hosts);
  const tailnet = useApp((s) => s.tailnet);
  // Removing asks once more, in place.
  const [removing, setRemoving] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="safe-top flex shrink-0 items-center gap-1 px-1.5 pb-2">
        <button onClick={onBack} aria-label="Back" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <ChevronLeft className="h-7 w-7" />
        </button>
        <h1 className="text-[20px] font-semibold text-mist-100">Settings</h1>
      </header>

      <main className="safe-bottom min-h-0 flex-1 overflow-y-auto px-4">
        <Section title="Machines">
          {config.hosts.map((h) => {
            const phase = phaseText(hosts[h.id]?.phase);
            return (
              <div key={h.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] text-mist-100">{h.id}</div>
                  <div className={`truncate text-[12.5px] ${phase?.tone ?? "text-jade-400"}`}>
                    {h.user} · {phase?.text ?? "connected"}
                  </div>
                </div>
                {removing === h.id ? (
                  <button
                    onClick={() => {
                      setRemoving(null);
                      void backend().then((b) => b.removeHost(h.id));
                    }}
                    className="rounded-lg bg-rose-400/15 px-3 py-1.5 text-[14px] font-medium text-rose-400 active:bg-rose-400/25"
                  >
                    Remove {h.id}
                  </button>
                ) : (
                  <>
                    <button onClick={() => backend().then((b) => b.reconnectHost(h.id))} className="rounded-lg px-2.5 py-1.5 text-[14px] text-mist-300 active:bg-ink-700">
                      Reconnect
                    </button>
                    <button onClick={() => setRemoving(h.id)} className="rounded-lg px-2.5 py-1.5 text-[14px] text-rose-400 active:bg-ink-700">
                      Remove
                    </button>
                  </>
                )}
              </div>
            );
          })}
          <button onClick={onAdd} className="flex w-full items-center gap-2 px-4 py-3 text-[15px] text-ember-400 active:bg-ink-700">
            <Plus className="h-4 w-4" /> Add a machine
          </button>
        </Section>

        <Section title="Tailnet">
          <div className="px-4 py-3 text-[14px] leading-snug text-mist-300">
            {inWebApp && tailnet?.selfNode ? (
              <>
                Consuls runs on <span className="text-mist-100">{tailnet.selfNode.id}</span>
                {tailnet.tailnetName && <> on {tailnet.tailnetName}</>}, and reaches your other machines from there.
              </>
            ) : tailnet?.via ? (
              <>
                This iPhone is <span className="text-mist-100">{tailnet.selfNode?.id ?? "not recognised"}</span>
                {tailnet.tailnetName && <> on {tailnet.tailnetName}</>}. The list of machines comes from{" "}
                <span className="text-mist-100">{tailnet.via}</span>.
              </>
            ) : (
              (tailnet?.error ?? "Not known yet.")
            )}
          </div>
        </Section>

        <Section title="Notifications">
          {inWebApp ? (
            <NotificationSettings />
          ) : (
            <div className="px-4 py-3 text-[14px] leading-snug text-mist-300">
              Pushes come through the Consuls web app on your Home Screen. Flip Notify on the agents you want to hear from; it's shared
              with every device.
            </div>
          )}
        </Section>
      </main>
    </div>
  );
}
