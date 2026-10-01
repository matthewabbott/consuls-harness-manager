// Notifications for this device (the web app): Web Push from the Consuls server. On iOS only
// the Home Screen app can get them, and asking needs a tap.

import { useCallback, useEffect, useState } from "react";

import type { PushInfo } from "../ipc/bindings/PushInfo";
import * as push from "./push";

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
        Agents with Notify on push when they're still waiting for you after a few minutes.
        {info && ` ${devices} device${devices === 1 ? "" : "s"} subscribed.`}
      </p>
    </div>
  );
}
