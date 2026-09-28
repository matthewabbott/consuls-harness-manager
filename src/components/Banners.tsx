import { ExternalLink, KeyRound, ShieldAlert, TriangleAlert, WifiOff } from "lucide-react";

import { backend } from "../ipc/backend";
import { useApp } from "../store/app";
import { useRedact } from "../store/recording";

function open(url: string) {
  backend().then((b) => b.openExternal(url));
}

function Banner({
  tone,
  icon,
  title,
  body,
  actions,
}: {
  tone: "iris" | "rose" | "ember";
  icon: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const ring = { iris: "ring-iris-400/30 bg-iris-400/[0.07]", rose: "ring-rose-400/30 bg-rose-400/[0.07]", ember: "ring-ember-400/30 bg-ember-400/[0.07]" }[tone];
  const fg = { iris: "text-iris-300", rose: "text-rose-400", ember: "text-ember-300" }[tone];
  return (
    <div className={`animate-rise flex items-center gap-3 rounded-xl px-4 py-3 ring-1 ${ring}`}>
      <span className={fg}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-mist-100">{title}</div>
        {body && <div className="mt-0.5 text-[12px] text-mist-400">{body}</div>}
      </div>
      <div className="flex shrink-0 gap-2">{actions}</div>
    </div>
  );
}

function Action({ onClick, children, primary }: { onClick: () => void; children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
        primary ? "bg-mist-100 text-ink-950 hover:bg-white" : "bg-ink-700 text-mist-200 hover:bg-ink-600"
      }`}
    >
      {children}
    </button>
  );
}

export default function Banners() {
  const tailnet = useApp((s) => s.tailnet);
  const hosts = useApp((s) => s.hosts);
  const r = useRedact();
  const items: React.ReactNode[] = [];

  if (tailnet?.error) {
    items.push(<Banner key="ts-err" tone="rose" icon={<WifiOff className="h-4 w-4" />} title="Can't read Tailscale status" body={r(tailnet.error)} />);
  } else if (tailnet && tailnet.backendState && tailnet.backendState !== "Running") {
    const needsLogin = tailnet.backendState === "NeedsLogin" || tailnet.backendState === "NeedsMachineAuth";
    items.push(
      <Banner
        key="ts-state"
        tone="ember"
        icon={<WifiOff className="h-4 w-4" />}
        title={needsLogin ? "Tailscale needs you to sign in" : `Tailscale is ${tailnet.backendState.toLowerCase()}`}
        body={needsLogin ? "Machines on your tailnet are unreachable until you sign in." : "Start Tailscale to reach your machines."}
        actions={
          tailnet.authUrl && (
            <Action primary onClick={() => open(tailnet.authUrl!)}>
              Sign in <ExternalLink className="h-3.5 w-3.5" />
            </Action>
          )
        }
      />,
    );
  }

  for (const h of Object.values(hosts)) {
    if (h.phase.phase === "awaitingTailscaleCheck") {
      const url = h.phase.url;
      items.push(
        <Banner
          key={`check-${h.id}`}
          tone="iris"
          icon={<ShieldAlert className="h-4 w-4" />}
          title={
            <>
              <span className="font-semibold">{r(h.id)}</span> is waiting for Tailscale SSH approval
            </>
          }
          body="Your tailnet policy asks for a quick re-check. Approve it in the browser and Consuls will connect automatically."
          actions={
            <Action primary onClick={() => open(url)}>
              Approve in browser <ExternalLink className="h-3.5 w-3.5" />
            </Action>
          }
        />,
      );
    } else if (h.phase.phase === "failed") {
      const mismatch = h.phase.kind === "hostKeyMismatch";
      items.push(
        <Banner
          key={`fail-${h.id}`}
          tone="rose"
          icon={mismatch ? <KeyRound className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
          title={
            <>
              Couldn't connect to <span className="font-semibold">{r(h.id)}</span>
            </>
          }
          body={r(h.phase.error)}
          actions={
            <>
              {mismatch && (
                <Action
                  onClick={() => {
                    if (confirm(`Only do this if you know ${r(h.id)}'s host key legitimately changed (e.g. reinstall). Trust the new key?`))
                      backend().then(async (b) => {
                        await b.forgetHostKey(h.id);
                        await b.connectHost(h.id);
                      });
                  }}
                >
                  Trust new key
                </Action>
              )}
              <Action onClick={() => useApp.getState().setSettingsFor(h.id)}>Settings…</Action>
              <Action primary onClick={() => backend().then((b) => b.connectHost(h.id))}>
                Retry
              </Action>
            </>
          }
        />,
      );
    }
  }

  if (items.length === 0) return null;
  return <div className="space-y-2 px-6 pt-1 pb-3">{items}</div>;
}
