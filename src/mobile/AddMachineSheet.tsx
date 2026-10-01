import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { backend } from "../ipc/backend";
import { useApp } from "../store/app";

/** A machine's id: the first label of its MagicDNS name, lowercase (as Tailscale lists it). */
function machineId(typed: string): string {
  return typed.trim().toLowerCase().split(".")[0].replace(/[^a-z0-9-]/g, "");
}

/**
 * Adds a machine: picked from the tailnet (known once one machine is connected) or typed, with
 * the user name to log in as. It connects over Tailscale SSH.
 */
export default function AddMachineSheet({ onClose }: { onClose(): void }) {
  const config = useApp((s) => s.config);
  const tailnet = useApp((s) => s.tailnet);
  const [name, setName] = useState("");
  const [user, setUser] = useState(config.hosts.at(-1)?.user ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const have = new Set(config.hosts.map((h) => h.id));
    return (tailnet?.peers ?? []).filter((p) => !p.isSelf && !have.has(p.id) && p.os !== "iOS" && p.os !== "android");
  }, [tailnet, config.hosts]);

  const id = machineId(name);
  const exists = config.hosts.some((h) => h.id === id);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await backend();
      await b.upsertHost({ id, address: null, port: 22, user: user.trim(), auth: { kind: "auto" }, autoConnect: true });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-ink-950/60" onClick={onClose}>
      <div className="safe-bottom max-h-[85%] overflow-y-auto rounded-t-3xl bg-ink-850 px-4 pt-4 ring-1 ring-ink-700" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <h2 className="flex-1 text-[18px] font-semibold text-mist-100">Add a machine</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-mist-400 active:bg-ink-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {candidates.length > 0 && (
          <>
            <div className="mt-3 text-[12px] font-medium tracking-wide text-mist-500 uppercase">On your tailnet</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {candidates.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setName(p.id)}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[14px] ring-1 ${
                    id === p.id ? "bg-ember-400/15 text-ember-300 ring-ember-400/50" : "bg-ink-800 text-mist-200 ring-ink-700"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${p.online ? "bg-jade-400" : "bg-mist-600"}`} />
                  {p.id}
                </button>
              ))}
            </div>
          </>
        )}

        <label className="mt-4 block">
          <span className="text-[13px] text-mist-400">Machine (its name in Tailscale)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="spark-d683"
            className="mt-1 w-full rounded-xl bg-ink-800 px-3.5 py-3 text-[16px] text-mist-100 ring-1 ring-ink-700 outline-none focus:ring-ember-400/60"
          />
        </label>
        <label className="mt-3 block">
          <span className="text-[13px] text-mist-400">Your user name on it</span>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1 w-full rounded-xl bg-ink-800 px-3.5 py-3 text-[16px] text-mist-100 ring-1 ring-ink-700 outline-none focus:ring-ember-400/60"
          />
        </label>
        <p className="mt-2 text-[12.5px] leading-snug text-mist-500">
          It needs Tailscale SSH turned on (<span className="font-mono">tailscale set --ssh</span>). If your tailnet asks for a check, an
          Approve button appears next to the machine.
        </p>
        {exists && <p className="mt-2 text-[13px] text-ember-300">{id} is already added.</p>}
        {error && <p className="mt-2 text-[13px] text-rose-400">{error}</p>}
        <button
          disabled={busy || !id || !user.trim() || exists}
          onClick={() => void add()}
          className="mt-4 mb-2 w-full rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-40"
        >
          Add {id || "machine"}
        </button>
      </div>
    </div>
  );
}
