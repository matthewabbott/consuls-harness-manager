import { useState } from "react";

import { backend } from "../ipc/backend";
import type { AuthMode } from "../ipc/bindings/AuthMode";
import type { HostConfig } from "../ipc/bindings/HostConfig";
import { useApp } from "../store/app";
import { useRedact } from "../store/recording";
import Modal, { Button } from "./Modal";

type AuthKind = AuthMode["kind"];

export default function HostSettingsDialog({ host }: { host: string }) {
  const close = () => useApp.getState().setSettingsFor(null);
  const existing = useApp((s) => s.config.hosts.find((h) => h.id === host));
  const peer = useApp((s) => s.tailnet?.peers.find((p) => p.id === host));
  const [user, setUser] = useState(existing?.user ?? "");
  const [address, setAddress] = useState(existing?.address ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [kind, setKind] = useState<AuthKind>(existing?.auth.kind ?? "auto");
  const [keyPath, setKeyPath] = useState(existing?.auth.kind === "keyFile" ? existing.auth.path : "");
  const [autoConnect, setAutoConnect] = useState(existing?.autoConnect ?? true);
  const [error, setError] = useState<string | null>(null);
  const r = useRedact();

  if (!existing) return null;
  const tsSsh = (peer?.sshHostKeys.length ?? 0) > 0;

  const save = async () => {
    const p = Number(port);
    if (!user.trim()) return setError("SSH user is required");
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setError("Port must be 1–65535");
    if (kind === "keyFile" && !keyPath.trim()) return setError("Choose a key file path");
    const auth: AuthMode = kind === "keyFile" ? { kind: "keyFile", path: keyPath.trim() } : { kind };
    const cfg: HostConfig = { ...existing, user: user.trim(), address: address.trim() || null, port: p, auth, autoConnect };
    try {
      const b = await backend();
      await b.upsertHost(cfg);
      if (autoConnect) await b.connectHost(host);
      close();
    } catch (e) {
      setError(String(e));
    }
  };

  const input = "w-full rounded-lg bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-mist-100 ring-1 ring-ink-600 outline-none placeholder:text-mist-500 focus:ring-sky-400/60";

  return (
    <Modal
      title={`Connection settings · ${r(host)}`}
      onClose={close}
      width={500}
      footer={
        <>
          {error && <span className="mr-auto truncate text-[12px] text-rose-400">{r(error)}</span>}
          <Button onClick={close}>Cancel</Button>
          <Button kind="primary" onClick={save}>
            Save &amp; connect
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <p className="text-[12px] leading-relaxed text-mist-400">
          {tsSsh
            ? "This machine runs Tailscale SSH, so no key is needed — just the user to log in as."
            : "This machine doesn't run Tailscale SSH. It needs a regular SSH server (on a Mac: System Settings → General → Sharing → Remote Login) and a key that it accepts."}
        </p>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Label text="SSH user">
            <input value={user} onChange={(e) => setUser(e.target.value)} className={`${input} personal font-mono`} />
          </Label>
          <Label text="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} className={`${input} font-mono`} />
          </Label>
        </div>
        <Label text="Address (optional)">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={peer?.ips[0] ? r(`Tailnet address: ${peer.ips.find((ip) => !ip.includes(":")) ?? peer.ips[0]}`) : "hostname or IP"}
            className={`${input} personal font-mono`}
          />
        </Label>
        <Label text="Authentication">
          <div className="flex gap-1.5">
            {(
              [
                ["auto", "Automatic"],
                ["agent", "SSH agent"],
                ["keyFile", "Key file"],
              ] as [AuthKind, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded-lg px-2.5 py-1 text-[12px] ring-1 transition-colors ${
                  kind === k ? "bg-sky-400/15 text-sky-400 ring-sky-400/50" : "bg-ink-850 text-mist-300 ring-ink-700 hover:bg-ink-750"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-mist-500">
            {kind === "auto" && "Tries Tailscale SSH, then your ssh-agent (Windows OpenSSH agent or Pageant), then ~/.ssh/id_ed25519, id_ecdsa, id_rsa."}
            {kind === "agent" && "Only keys loaded in the Windows OpenSSH agent or Pageant."}
            {kind === "keyFile" && "An unencrypted private key file on this computer (passphrase-protected keys: load them into ssh-agent instead)."}
          </p>
          {kind === "keyFile" && (
            <input
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="C:\Users\you\.ssh\id_ed25519"
              spellCheck={false}
              className={`${input} personal mt-2 font-mono`}
            />
          )}
        </Label>
        <label className="flex items-center gap-2 text-[12.5px] text-mist-300">
          <input type="checkbox" checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} /> Connect automatically and keep
          reconnecting
        </label>
      </div>
    </Modal>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-mist-400 uppercase">{text}</div>
      {children}
    </div>
  );
}
