import { BellRing, Laptop, Monitor, Plug, Plus, RefreshCw, RotateCw, Server, Settings2, Smartphone, Trash2, Unplug } from "lucide-react";
import { useState } from "react";

import { backend } from "../ipc/backend";
import type { HostConfig } from "../ipc/bindings/HostConfig";
import { defaultUser, isLocal, machines, phaseInfo, toneText, type Machine } from "../lib/hosts";
import { useApp } from "../store/app";
import { useRedact } from "../store/recording";
import HideSidebarButton from "./HideSidebarButton";
import LabelsPanel from "./LabelsPanel";

function OsIcon({ os, className }: { os: string | undefined; className?: string }) {
  const o = (os ?? "").toLowerCase();
  if (o === "ios" || o === "android") return <Smartphone className={className} />;
  if (o === "macos") return <Laptop className={className} />;
  if (o === "windows") return <Monitor className={className} />;
  return <Server className={className} />;
}

function HostRow({ m }: { m: Machine }) {
  const focusHost = useApp((s) => s.focusHost);
  const setFocusHost = useApp((s) => s.setFocusHost);
  const paneCount = useApp((s) => s.panes[m.id]?.length ?? 0);
  const waitingCount = useApp((s) => (s.panes[m.id] ?? []).filter((p) => s.attention[p.key]?.attention === "unacked").length);
  const local = isLocal(m.id);
  const info = local ? { label: "This computer", tone: "jade" as const, busy: false } : phaseInfo(m.state?.phase, m.peer?.online);
  const connected = m.state?.phase.phase === "connected";
  const idle = !m.state || ["disconnected", "failed"].includes(m.state.phase.phase);
  const active = focusHost === m.id;
  const r = useRedact();

  return (
    <div
      onClick={() => setFocusHost(active ? null : m.id)}
      className={`group relative flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
        active ? "bg-ink-700/80" : "hover:bg-ink-750"
      }`}
    >
      <span className={`status-dot h-2 w-2 shrink-0 rounded-full bg-current ${toneText[info.tone]} ${info.busy ? "animate-breathe" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <OsIcon os={local ? "windows" : m.peer?.os} className="h-3.5 w-3.5 shrink-0 text-mist-500" />
          <span className="truncate text-[13px] font-medium text-mist-100">{r(m.label)}</span>
        </div>
        <div className={`truncate text-[11px] ${info.tone === "mist" ? "text-mist-500" : toneText[info.tone]}`}>{info.label}</div>
      </div>
      {connected && waitingCount > 0 ? (
        <span
          title={`${waitingCount} waiting on you`}
          className="rounded-md bg-ember-400/20 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-ember-300 ring-1 ring-ember-400/40 group-hover:hidden"
        >
          {waitingCount}
        </span>
      ) : (
        connected &&
        paneCount > 0 && <span className="rounded-md bg-ink-600/70 px-1.5 py-0.5 font-mono text-[10.5px] text-mist-300 group-hover:hidden">{paneCount}</span>
      )}
      <div className="hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        {local ? (
          <>
            <IconButton title="New shell on this PC" onClick={() => useApp.getState().openNewPane(m.id)}>
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title="Notifications for hand-started agents…" onClick={() => useApp.getState().setIntegrationFor(m.id)}>
              <BellRing className="h-3.5 w-3.5" />
            </IconButton>
          </>
        ) : (
          <HostActions m={m} idle={idle} connected={connected} />
        )}
      </div>
    </div>
  );
}

function HostActions({ m, idle, connected }: { m: Machine; idle: boolean; connected: boolean }) {
  const r = useRedact();
  return (
    <>
      {idle ? (
        <IconButton title="Connect" onClick={() => backend().then((b) => b.connectHost(m.id))}>
          <Plug className="h-3.5 w-3.5" />
        </IconButton>
      ) : (
        <IconButton title="Disconnect" onClick={() => backend().then((b) => b.disconnectHost(m.id))}>
          <Unplug className="h-3.5 w-3.5" />
        </IconButton>
      )}
      <IconButton title="Connection settings…" onClick={() => useApp.getState().setSettingsFor(m.id)}>
        <Settings2 className="h-3.5 w-3.5" />
      </IconButton>
      {!idle && (
        <IconButton title="Reconnect" onClick={() => backend().then((b) => b.reconnectHost(m.id))}>
          <RotateCw className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {connected && (
        <IconButton title="Notifications for hand-started agents…" onClick={() => useApp.getState().setIntegrationFor(m.id)}>
          <BellRing className="h-3.5 w-3.5" />
        </IconButton>
      )}
      <IconButton
        title="Remove machine"
        onClick={() => {
          if (confirm(`Remove ${r(m.id)} from Consuls? Its tmux sessions keep running.`)) backend().then((b) => b.removeHost(m.id));
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded-md p-1 text-mist-400 transition-colors hover:bg-ink-600 hover:text-mist-100"
    >
      {children}
    </button>
  );
}

function AvailableRow({ m }: { m: Machine }) {
  const configs = useApp((s) => s.config.hosts);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(() => defaultUser(configs));
  const peer = m.peer!;
  const tsSsh = peer.sshHostKeys.length > 0;
  const r = useRedact();

  const add = async () => {
    if (!user.trim()) return;
    const config: HostConfig = { id: m.id, address: null, port: 22, user: user.trim(), auth: { kind: "auto" }, autoConnect: true };
    await (await backend()).upsertHost(config);
    setOpen(false);
  };

  return (
    <div className={`rounded-lg transition-colors ${open ? "bg-ink-750" : "hover:bg-ink-750/70"}`}>
      <div className="group flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5" onClick={() => peer.online && setOpen(!open)}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${peer.online ? "bg-mist-500" : "bg-ink-500"}`} />
        <OsIcon os={peer.os} className="h-3.5 w-3.5 shrink-0 text-mist-500" />
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${peer.online ? "text-mist-300" : "text-mist-500"}`}>{r(m.label)}</span>
        {peer.online ? (
          <Plus className="h-3.5 w-3.5 text-mist-500 opacity-0 transition-opacity group-hover:opacity-100" />
        ) : (
          <span className="text-[10.5px] text-mist-500">offline</span>
        )}
      </div>
      {open && (
        <form
          className="animate-rise space-y-2 px-2.5 pt-0.5 pb-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="block text-[11px] text-mist-400">
            SSH user
            <input
              autoFocus
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={r("e.g. consulear")}
              className="personal mt-1 block w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 font-mono text-[12px] text-mist-100 outline-none focus:border-sky-400/60"
            />
          </label>
          <p className="text-[10.5px] leading-snug text-mist-500">
            {tsSsh ? "Uses Tailscale SSH — no keys needed." : "Uses your SSH agent or ~/.ssh keys (no Tailscale SSH on this machine)."}
          </p>
          <button
            type="submit"
            disabled={!user.trim()}
            className="w-full rounded-md bg-sky-400/90 py-1.5 text-[12px] font-semibold text-ink-950 transition-colors hover:bg-sky-400 disabled:opacity-40"
          >
            Connect
          </button>
        </form>
      )}
    </div>
  );
}

/** The Machines tab of the left sidebar. */
export default function MachinesPanel() {
  const tailnet = useApp((s) => s.tailnet);
  const config = useApp((s) => s.config);
  const hosts = useApp((s) => s.hosts);
  const { configured, available } = machines(tailnet, config.hosts, hosts);
  const [refreshing, setRefreshing] = useState(false);
  const r = useRedact();

  const refresh = async () => {
    setRefreshing(true);
    try {
      const status = await (await backend()).refreshTailnet();
      useApp.getState().apply({ type: "tailnet", status });
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  return (
    <>
      <div className="flex items-start gap-2.5 pt-4 pr-2.5 pb-3 pl-4">
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[9.5px] font-semibold tracking-[0.14em] text-ember-400/80 uppercase">Consul's</div>
          <div className="font-display text-[15px] font-semibold tracking-tight text-mist-100">Harness Manager</div>
        </div>
        <HideSidebarButton />
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-4">
        <SectionLabel>Machines</SectionLabel>
        {configured.length === 0 ? (
          <p className="px-2.5 py-1 text-[12px] leading-relaxed text-mist-500">Add a machine from your tailnet below to pull in its tmux sessions.</p>
        ) : (
          <div className="space-y-0.5">
            {configured.map((m) => (
              <HostRow key={m.id} m={m} />
            ))}
          </div>
        )}

        <div className="mt-5">
          <LabelsPanel />
        </div>

        <div className="mt-5 flex items-center justify-between pr-1">
          <SectionLabel>On your tailnet</SectionLabel>
          <button onClick={refresh} title="Refresh" className="rounded p-1 text-mist-500 hover:text-mist-200">
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="space-y-0.5">
          {available.map((m) => (
            <AvailableRow key={m.id} m={m} />
          ))}
          {available.length === 0 && <p className="px-2.5 text-[11.5px] text-mist-500">Nothing else found.</p>}
        </div>
      </div>
      {tailnet?.tailnetName && (
        <div className="truncate border-t border-ink-700/80 px-4 py-2 text-[10.5px] text-mist-500" title="Tailnet">
          {r(tailnet.tailnetName)}
        </div>
      )}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">{children}</div>;
}
