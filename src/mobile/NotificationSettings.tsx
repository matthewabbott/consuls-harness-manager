// Notifications for this device (the web app): Web Push from the Consuls server. On iOS only
// the Home Screen app can get them, and asking needs a tap.

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { backend } from "../ipc/backend";
import type { NotifyPrefs } from "../ipc/bindings/NotifyPrefs";
import type { PushInfo } from "../ipc/bindings/PushInfo";
import { pausedText, UNTIL_RESUMED } from "../lib/notifyModes";
import { useApp } from "../store/app";
import * as push from "./push";

const DELAYS = [0, 15, 30, 60, 120, 180, 300];

function seconds(s: number): string {
  return s === 0 ? "No wait" : s < 60 ? `${s} s` : `${s / 60} min`;
}

/** The next 8:00 after now (unix seconds). */
function tomorrowMorning(): number {
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

function save(prefs: NotifyPrefs) {
  // Shown at once; the server saves it and echoes the config back.
  const app = useApp.getState();
  useApp.setState({ config: { ...app.config, notify: prefs } });
  void backend()
    .then((b) => b.setNotifyPrefs(prefs))
    .catch((e) => app.notify("error", `Couldn't save: ${e}`));
}

function Pill({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-lg bg-ink-700 px-3 py-2 text-[14px] text-mist-100 active:bg-ink-600">
      {children}
    </button>
  );
}

function Delay({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  return (
    <label className="mt-2 flex items-center gap-3">
      <span className="flex-1 text-[14px] text-mist-300">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-lg bg-ink-700 px-2.5 py-1.5 text-[14px] text-mist-100 ring-1 ring-ink-600 outline-none"
      >
        {[...new Set([...DELAYS, value])].sort((a, b) => a - b).map((d) => (
          <option key={d} value={d}>
            {seconds(d)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Pause for everyone (every device gets nothing while paused), and the delays (advanced). */
export function PushPrefs() {
  const prefs = useApp((s) => s.config.notify);
  const [advanced, setAdvanced] = useState(false);
  const paused = pausedText(prefs.pausedUntil);
  const pause = (until: number) => save({ ...prefs, pausedUntil: until });
  return (
    <div className="border-t border-ink-700 px-4 py-3">
      {paused ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[15px] text-ember-300">{paused}</span>
          <Pill onClick={() => save({ ...prefs, pausedUntil: null })}>Resume</Pill>
        </div>
      ) : (
        <>
          <div className="text-[14px] text-mist-300">Pause notifications</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill onClick={() => pause(Math.floor(Date.now() / 1000) + 3600)}>1 hour</Pill>
            <Pill onClick={() => pause(tomorrowMorning())}>Until 8:00</Pill>
            <Pill onClick={() => pause(UNTIL_RESUMED)}>Until I resume</Pill>
          </div>
        </>
      )}
      <button onClick={() => setAdvanced(!advanced)} className="mt-3 flex items-center gap-1 text-[13px] text-mist-500 active:text-mist-300">
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advanced ? "" : "-rotate-90"}`} /> Advanced
      </button>
      {advanced && (
        <div className="mt-1">
          <p className="text-[12.5px] leading-snug text-mist-500">
            For agents set to "After a delay": the push goes out only if the agent is still waiting for you by then.
          </p>
          <Delay label="After a finished turn" value={prefs.finishedSecs} onChange={(v) => save({ ...prefs, finishedSecs: v })} />
          <Delay label="When it needs input" value={prefs.needsInputSecs} onChange={(v) => save({ ...prefs, needsInputSecs: v })} />
        </div>
      )}
    </div>
  );
}

export default function NotificationSettings() {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [state, setState] = useState<{ status: push.PushStatus; endpoint: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState(await push.status().catch(() => ({ status: "unsupported" as const, endpoint: null })));
    setInfo(await push.api.info().catch(() => null));
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const run = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
      if (done) setNote(done);
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const devices = info?.subscriptions.length ?? 0;
  return (
    <div className="px-4 py-3">
      {state?.status === "needs-install" && (
        <p className="text-[14px] leading-snug text-mist-200">
          Add Consuls to your Home Screen first: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open it from there.
        </p>
      )}
      {state?.status === "unsupported" && <p className="text-[14px] text-mist-300">This browser can't receive push notifications.</p>}
      {state?.status === "denied" && <p className="text-[14px] text-mist-300">Blocked: allow them in Settings → Notifications → Consuls.</p>}
      {state?.status === "off" && (
        <button
          disabled={busy || !info}
          onClick={() => void run(() => push.enable(info!.vapidPublicKey))}
          className="w-full rounded-xl bg-jade-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-50"
        >
          Enable notifications
        </button>
      )}
      {state?.status === "on" && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[15px] text-jade-400">On for this device</span>
          <button
            disabled={busy}
            onClick={() => void run(() => push.api.test(state.endpoint!), "Sent: it should arrive in a moment.")}
            className="rounded-lg bg-ink-700 px-3 py-2 text-[14px] text-mist-100 active:bg-ink-600"
          >
            Send test
          </button>
          <button disabled={busy} onClick={() => void run(push.disable)} className="rounded-lg px-3 py-2 text-[14px] text-mist-400 active:bg-ink-700">
            Turn off
          </button>
        </div>
      )}
      {note && <p className="mt-2 text-[13px] text-ember-300">{note}</p>}
      <p className="mt-2 text-[12.5px] leading-snug text-mist-500">
        Agents with Notify on push when they're still waiting for you a minute later (each agent's ⋯ menu has other choices).
        {info && ` ${devices} device${devices === 1 ? "" : "s"} subscribed.`}
      </p>
    </div>
  );
}
