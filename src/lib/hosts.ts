import type { HostConfig } from "../ipc/bindings/HostConfig";
import type { HostPhase } from "../ipc/bindings/HostPhase";
import type { HostState } from "../ipc/bindings/HostState";
import type { TailnetPeer } from "../ipc/bindings/TailnetPeer";
import type { TailnetStatus } from "../ipc/bindings/TailnetStatus";

export interface Machine {
  id: string;
  label: string;
  peer: TailnetPeer | null;
  config: HostConfig | null;
  state: HostState | null;
}

/** Configured hosts first (in config order), then other tailnet peers. */
export function machines(tailnet: TailnetStatus | null, configs: HostConfig[], states: Record<string, HostState>): {
  configured: Machine[];
  available: Machine[];
} {
  const peers = tailnet?.peers ?? [];
  const configured = configs.map((config) => {
    const peer = peers.find((p) => p.id === config.id) ?? null;
    return { id: config.id, label: config.id, peer, config, state: states[config.id] ?? null };
  });
  const available = peers
    .filter((p) => !configs.some((c) => c.id === p.id))
    .map((peer) => ({ id: peer.id, label: peer.id, peer, config: null, state: null }))
    .sort((a, b) => Number(b.peer!.online) - Number(a.peer!.online) || a.id.localeCompare(b.id));
  return { configured, available };
}

export type Tone = "jade" | "ember" | "iris" | "rose" | "mist" | "sky";

export function phaseInfo(phase: HostPhase | undefined, online: boolean | undefined): { label: string; tone: Tone; busy: boolean } {
  switch (phase?.phase) {
    case "connected":
      return { label: "Connected", tone: "jade", busy: false };
    case "connecting":
      return { label: "Connecting…", tone: "sky", busy: true };
    case "awaitingTailscaleCheck":
      return { label: "Needs approval", tone: "iris", busy: true };
    case "reconnecting":
      return { label: `Reconnecting in ${Math.round(phase.retryInMs / 1000)}s`, tone: "ember", busy: true };
    case "failed":
      return { label: phase.kind === "hostKeyMismatch" ? "Host key changed" : phase.kind === "auth" ? "Login failed" : "Failed", tone: "rose", busy: false };
    default:
      return online === false ? { label: "Offline", tone: "mist", busy: false } : { label: "Disconnected", tone: "mist", busy: false };
  }
}

export const toneText: Record<Tone, string> = {
  jade: "text-jade-400",
  ember: "text-ember-400",
  iris: "text-iris-400",
  rose: "text-rose-400",
  mist: "text-mist-500",
  sky: "text-sky-400",
};

/** A sensible default SSH user: whatever the user picked for other machines. */
export function defaultUser(configs: HostConfig[]): string {
  const counts = new Map<string, number>();
  for (const c of configs) counts.set(c.user, (counts.get(c.user) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

export function shortPath(path: string, home?: string | null): string {
  let p = path;
  if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
  else p = p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
  const parts = p.split("/");
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join("/")}` : p;
}
