// The phone app's first screen: notifications, and every agent on every machine with a switch to
// track it (tracked agents push when they're still waiting for you after a while).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DaemonState } from "../ipc/bindings/DaemonState";
import type { Harness } from "../ipc/bindings/Harness";
import type { HostPhase } from "../ipc/bindings/HostPhase";
import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { displayTitle } from "../lib/panes";
import { api, ApiError } from "./api";
import * as push from "./push";

const HARNESS_DOT: Record<Harness, string> = {
  claude: "bg-claude",
  codex: "bg-codex",
  omp: "bg-omp",
  pi: "bg-pi",
  opencode: "bg-opencode",
  gemini: "bg-gemini",
  shell: "bg-mist-500",
};

const HARNESS_NAME: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  omp: "omp",
  pi: "pi",
  opencode: "opencode",
  gemini: "Gemini",
  shell: "shell",
};

/** Agents (and anything already tracked): the panes worth a switch. */
const trackable = (p: PaneInfo) => p.kind === "tmux" && (p.notify !== null || (p.harness !== null && p.harness !== "shell"));

/** `#pane=spark2/%3`, from a tapped notification. */
function paneFromHash(): string | null {
  const m = window.location.hash.match(/^#pane=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function status(att: PaneAttention | undefined): { text: string; tone: string } {
  if (!att) return { text: "", tone: "text-mist-400" };
  switch (att.activity) {
    case "working":
      return { text: "working", tone: "text-sky-400" };
    case "needsInput":
      return { text: att.reason ?? "needs you", tone: "text-iris-300" };
    case "idle":
      return att.attention === "none" ? { text: "idle", tone: "text-mist-400" } : { text: "waiting on you", tone: "text-ember-300" };
    default:
      return { text: "", tone: "text-mist-400" };
  }
}

function phaseText(phase: HostPhase | undefined): { text: string; tone: string } | null {
  if (!phase) return null;
  switch (phase.phase) {
    case "connected":
      return null;
    case "awaitingTailscaleCheck":
      return { text: "waiting for Tailscale SSH approval", tone: "text-iris-300" };
    case "failed":
      return { text: `failed: ${phase.error}`, tone: "text-rose-400" };
    case "reconnecting":
      return { text: "reconnecting…", tone: "text-ember-300" };
    default:
      return { text: phase.phase, tone: "text-mist-400" };
  }
}

export default function App() {
  const [state, setState] = useState<DaemonState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<{ status: push.PushStatus; endpoint: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(paneFromHash());
  const resynced = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "This isn't yours: open it from your own device, over Tailscale." : `Can't reach the daemon: ${String(e instanceof Error ? e.message : e)}`);
    }
  }, []);

  // Poll while on screen.
  useEffect(() => {
    void refresh();
    const tick = window.setInterval(() => document.visibilityState === "visible" && void refresh(), 5000);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Notifications: register, see where we stand, and re-tell the daemon about this device.
  useEffect(() => {
    void push.register().then(push.status).then(setPushState).catch(() => setPushState({ status: "unsupported", endpoint: null }));
  }, []);
  useEffect(() => {
    if (!state || resynced.current) return;
    resynced.current = true;
    void push.resync(state.vapidPublicKey).catch(() => {});
  }, [state]);

  // A tapped notification points at a pane.
  useEffect(() => {
    const onHash = () => setFocus(paneFromHash());
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open") window.location.hash = new URL(e.data.url).hash;
    };
    window.addEventListener("hashchange", onHash);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("hashchange", onHash);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, []);

  const attention = useMemo(() => new Map((state?.snapshot.attention ?? []).map((a) => [a.key, a])), [state]);
  const pending = useMemo(() => new Map((state?.pending ?? []).map((p) => [p.key, p])), [state]);
  const hostName = useCallback((host: string) => (host === "@local" ? state?.selfHost || "this machine" : host), [state]);

  // Opening a pane from a notification: you've seen it, and it's highlighted.
  const focused = useMemo(() => {
    if (!focus || !state) return null;
    return state.snapshot.panes.find((p) => p.tmux && `${hostName(p.host)}/${p.tmux.paneId}` === focus) ?? null;
  }, [focus, state, hostName]);
  useEffect(() => {
    if (!focused) return;
    void api.seen(focused.key).catch(() => {});
    document.getElementById(`pane-${focused.key}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);

  const machines = useMemo(() => {
    if (!state) return [];
    const ids = [...new Set(["@local", ...state.snapshot.hosts.map((h) => h.id), ...state.snapshot.panes.map((p) => p.host)])];
    return ids
      .map((id) => ({
        id,
        phase: state.snapshot.hosts.find((h) => h.id === id)?.phase,
        panes: state.snapshot.panes.filter((p) => p.host === id && trackable(p)).sort((a, b) => displayTitle(a).localeCompare(displayTitle(b))),
      }))
      .filter((m) => m.panes.length > 0 || m.id !== "@local");
  }, [state]);

  const toggle = async (p: PaneInfo) => {
    const mode = p.notify ? null : "delay";
    setState((s) => (s ? { ...s, snapshot: { ...s.snapshot, panes: s.snapshot.panes.map((q) => (q.key === p.key ? { ...q, notify: mode } : q)) } } : s));
    try {
      await api.setNotify(p.key, mode);
    } catch (e) {
      setNote(`Couldn't change it: ${String(e instanceof Error ? e.message : e)}`);
    }
    window.setTimeout(() => void refresh(), 1200);
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
    } catch (e) {
      setNote(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setPushState(await push.status().catch(() => null));
      void refresh();
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),2rem)]">
      <header className="flex items-baseline justify-between py-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-mist-100">Consuls</h1>
        {state && <span className="text-[12px] text-mist-500">via {state.selfHost || "the push daemon"}</span>}
      </header>

      {error && <div className="mb-3 rounded-2xl bg-rose-400/10 px-4 py-3 text-[14px] text-rose-400 ring-1 ring-rose-400/30">{error}</div>}

      <section className="mb-5 rounded-2xl bg-ink-800 px-4 py-3.5 ring-1 ring-ink-700">
        <div className="text-[13px] font-medium tracking-wide text-mist-400 uppercase">Notifications</div>
        {pushState?.status === "needs-install" && (
          <p className="mt-2 text-[15px] leading-snug text-mist-200">
            Add Consuls to your Home Screen first: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open it from there.
          </p>
        )}
        {pushState?.status === "unsupported" && <p className="mt-2 text-[15px] text-mist-300">This browser can't receive push notifications.</p>}
        {pushState?.status === "denied" && <p className="mt-2 text-[15px] text-mist-300">Blocked. Allow them in Settings → Notifications → Consuls.</p>}
        {pushState?.status === "off" && (
          <button
            disabled={busy || !state}
            onClick={() => void run(async () => void (await push.enable(state!.vapidPublicKey)))}
            className="mt-3 w-full rounded-xl bg-jade-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-50"
          >
            Enable notifications
          </button>
        )}
        {pushState?.status === "on" && (
          <div className="mt-2 flex items-center gap-2">
            <span className="flex-1 text-[15px] text-jade-400">On for this device</span>
            <button disabled={busy} onClick={() => void run(() => api.test(pushState.endpoint!))} className="rounded-lg bg-ink-700 px-3 py-2 text-[14px] text-mist-100 active:bg-ink-600">
              Send test
            </button>
            <button disabled={busy} onClick={() => void run(push.disable)} className="rounded-lg px-3 py-2 text-[14px] text-mist-400 active:bg-ink-700">
              Turn off
            </button>
          </div>
        )}
        {note && <p className="mt-2 text-[13px] text-ember-300">{note}</p>}
        <p className="mt-2 text-[12.5px] leading-snug text-mist-500">Tracked agents push when they're still waiting for you after a few minutes.</p>
      </section>

      {!state && !error && <p className="text-center text-[14px] text-mist-500">Loading…</p>}

      {machines.map((m) => {
        const phase = phaseText(m.phase);
        return (
          <section key={m.id} className="mb-5">
            <div className="mb-2 flex items-baseline gap-2 px-1">
              <h2 className="text-[15px] font-semibold text-mist-100">{hostName(m.id)}</h2>
              {phase && <span className={`truncate text-[12px] ${phase.tone}`}>{phase.text}</span>}
              {m.phase?.phase === "awaitingTailscaleCheck" && (
                <a href={m.phase.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 rounded-lg bg-iris-400/15 px-2.5 py-1 text-[13px] font-medium text-iris-300">
                  Approve
                </a>
              )}
            </div>
            {m.panes.length === 0 ? (
              <p className="px-1 text-[13px] text-mist-500">No agents running.</p>
            ) : (
              <ul className="space-y-2">
                {m.panes.map((p) => {
                  const st = status(attention.get(p.key));
                  const due = pending.get(p.key);
                  const on = p.notify !== null;
                  return (
                    <li
                      key={p.key}
                      id={`pane-${p.key}`}
                      className={`flex items-center gap-3 rounded-2xl bg-ink-800/80 px-3.5 py-3 ring-1 transition-shadow ${focused?.key === p.key ? "ring-2 ring-ember-400" : "ring-ink-700"}`}
                    >
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${HARNESS_DOT[p.harness ?? "shell"]}`} title={HARNESS_NAME[p.harness ?? "shell"]} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px] font-medium text-mist-100">{displayTitle(p)}</div>
                        <div className="truncate text-[12.5px]">
                          <span className={st.tone}>{st.text || HARNESS_NAME[p.harness ?? "shell"]}</span>
                          {due && <span className="text-mist-400"> · push in {mmss(due.dueInMs)}</span>}
                        </div>
                      </div>
                      <button
                        role="switch"
                        aria-checked={on}
                        aria-label={on ? "Stop pushing for this agent" : "Push when this agent waits for you"}
                        onClick={() => void toggle(p)}
                        className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${on ? "bg-jade-400" : "bg-ink-600"}`}
                      >
                        <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-[left] ${on ? "left-[22px]" : "left-[2px]"}`} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {state && (
        <footer className="mt-8 text-center text-[11.5px] text-mist-500">
          {state.subscriptions.length} device{state.subscriptions.length === 1 ? "" : "s"} subscribed
          {state.rssKb !== null && ` · daemon ${Math.round(state.rssKb / 1024)} MB`}
        </footer>
      )}
    </div>
  );
}
