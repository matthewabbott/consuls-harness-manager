// The web app's start: nothing works without the Consuls server, so until it answers this shows
// where things stand (and, when it can't be reached, how to start it by hand). Afterwards a
// dropped connection is a banner over the app, and another device taking over a full screen.

import { Copy, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { useConnection } from "../ipc/webBackend";
import { loadUiState } from "../lib/uiState";
import { useUi } from "../store/ui";
import { useViewPrefs } from "../store/viewPrefs";
import App from "./App";
import { api, resync } from "./push";

/** The server's machine: the web app is served from it. */
const serverHost = location.hostname.split(".")[0] || "the server";
const START = "~/.local/share/consuls-server/consuls-server start";

function StartCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 rounded-xl bg-ink-900 px-3 py-2.5 ring-1 ring-ink-700">
      <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-mist-200">{START}</code>
      <button
        onClick={() => void navigator.clipboard.writeText(START).then(() => setCopied(true))}
        aria-label="Copy the command"
        className="shrink-0 rounded-lg p-2 text-mist-300 active:bg-ink-700"
      >
        {copied ? <span className="text-[12px] text-jade-400">Copied</span> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Offline({ connecting }: { connecting: boolean }) {
  const retry = useConnection((s) => s.retry);
  return (
    <div className="safe-top flex h-full flex-col bg-ink-900 px-5">
      <h1 className="pt-2 text-[28px] font-bold tracking-tight text-mist-100">Consuls</h1>
      {connecting ? (
        <p className="mt-6 text-[15px] text-mist-400">Connecting to {serverHost}…</p>
      ) : (
        <section className="mt-6 rounded-2xl bg-ink-800 px-4 py-4 ring-1 ring-ink-700">
          <h2 className="text-[17px] font-semibold text-mist-100">Can't reach the Consuls server on {serverHost}</h2>
          <p className="mt-1.5 text-[14px] leading-snug text-mist-400">
            It isn't running (it stops when {serverHost} restarts, or after a week unused), or Tailscale is off on this phone. To start
            it, SSH into {serverHost} (Termius works) and run:
          </p>
          <StartCommand />
          <button onClick={retry} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80">
            <RotateCw className="h-4 w-4" /> Try again
          </button>
          <p className="mt-3 text-[12.5px] leading-snug text-mist-500">Notifications still arrive whenever the server is running.</p>
        </section>
      )}
    </div>
  );
}

function TakenOver() {
  const retry = useConnection((s) => s.retry);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-ink-800 px-5 py-5 text-center ring-1 ring-ink-600">
        <h2 className="text-[17px] font-semibold text-mist-100">Open on another device</h2>
        <p className="mt-1.5 text-[14px] leading-snug text-mist-400">Consuls is in use elsewhere (one device at a time).</p>
        <button onClick={retry} className="mt-4 w-full rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80">
          Use here
        </button>
      </div>
    </div>
  );
}

export default function WebGate() {
  const state = useConnection((s) => s.state);
  const [ready, setReady] = useState(false);

  // The first time the server answers: its copy of the UI's state, then the app.
  useEffect(() => {
    if (state !== "open" || ready) return;
    void loadUiState().finally(async () => {
      await useUi.persist.rehydrate();
      await useViewPrefs.persist.rehydrate();
      setReady(true);
      // Tell the server about this device's push subscription again (Safari doesn't say when
      // one changes).
      void api.info().then((info) => resync(info.vapidPublicKey)).catch(() => {});
    });
  }, [state, ready]);

  if (!ready) return state === "takenOver" ? <TakenOver /> : <Offline connecting={state === "connecting"} />;
  return (
    <>
      <App />
      {state === "takenOver" && <TakenOver />}
      {(state === "offline" || state === "connecting") && (
        <div className="safe-top pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center">
          <span className="mt-1 rounded-full bg-ember-400/15 px-3 py-1 text-[12.5px] text-ember-300 ring-1 ring-ember-400/40 backdrop-blur">
            {state === "offline" ? `Can't reach ${serverHost} — retrying` : "Reconnecting…"}
          </span>
        </div>
      )}
    </>
  );
}
