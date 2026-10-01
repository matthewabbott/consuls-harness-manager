// Starting an agent (or a shell) from the phone: which machine, what to run, in which folder, and
// in a new tmux session or beside an existing one. Like the desktop's new-pane dialog, minus
// plain shells: those would live in the server and end with it.

import { ChevronLeft, CornerLeftUp, Folder, Home, Loader2, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import HarnessBadge from "../components/HarnessBadge";
import { openWhenListed } from "../components/PrefixKeys";
import { backend } from "../ipc/backend";
import type { DirListing } from "../ipc/bindings/DirListing";
import type { Harness } from "../ipc/bindings/Harness";
import { baseName, isRoot, joinPath, parentPath } from "../lib/paths";
import { shortPath } from "../lib/hosts";
import { uiStorage } from "../lib/uiState";
import { useApp } from "../store/app";

const HARNESSES: { id: Harness; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "omp", label: "omp" },
  { id: "shell", label: "Shell" },
];

/** Shared with the desktop's dialog: the last thing started. */
const LAST_HARNESS = "consuls.newPane.harness";

function lastHarness(): Harness {
  const v = uiStorage.getItem(LAST_HARNESS) as Harness | null;
  return v && HARNESSES.some((h) => h.id === v) ? v : "claude";
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[14px] ring-1 ${
        on ? "bg-ember-400/15 text-ember-300 ring-ember-400/50" : "bg-ink-800 text-mist-200 ring-ink-700 active:bg-ink-700"
      }`}
    >
      {children}
    </button>
  );
}

/** The end of a long path, which is the part that tells folders apart. */
const pathTail = (path: string) => (path.length > 40 ? `…${path.slice(-39)}` : path);

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 mb-1.5 text-[12px] font-medium tracking-wide text-mist-500 uppercase">{children}</div>;
}

export default function NewSessionSheet({ host: preselect, onClose }: { host: string | null; onClose(): void }) {
  const hosts = useApp((s) => s.hosts);
  const panes = useApp((s) => s.panes);
  const selfName = useApp((s) => s.tailnet?.selfNode?.id ?? "this machine");
  const defaults = useApp((s) => s.config.ui.defaultFolders);
  const connected = Object.values(hosts)
    .filter((h) => h.phase.phase === "connected")
    .map((h) => h.id);
  const name = (id: string) => (id === "@local" ? selfName : id);

  const [host, setHost] = useState(() => (preselect && connected.includes(preselect) ? preselect : (connected[0] ?? "")));
  const [harness, setHarness] = useState<Harness>(lastHarness);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const facts = hosts[host]?.facts;
  const home = facts?.home ?? listing?.home ?? null;
  const hostPanes = panes[host] ?? [];
  const recent = useMemo(() => {
    const seen = new Set<string>();
    for (const p of hostPanes) if (p.currentPath && p.currentPath !== home) seen.add(p.currentPath);
    return [...seen].slice(0, 6);
  }, [hostPanes, home]);
  const sessions = useMemo(() => [...new Set(hostPanes.flatMap((p) => (p.tmux ? [p.tmux.sessionName] : [])))], [hostPanes]);
  const noTmux = !!facts && !facts.tmuxVersion;

  const open = async (path: string) => {
    if (!host) return;
    setLoading(true);
    setError(null);
    try {
      setListing(await (await backend()).listDir(host, path));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setListing(null);
    setSession("");
    if (host) void open(defaults[host] ?? recent[0] ?? "~");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const cwd = listing?.path ?? "";
  const dirs = (listing?.entries ?? []).filter((e) => e.isDir && !e.name.startsWith("."));

  const start = async () => {
    if (!host || !cwd) return;
    setCreating(true);
    setError(null);
    try {
      uiStorage.setItem(LAST_HARNESS, harness);
      const key = await (await backend()).createPane({ host, cwd, harness, name: title.trim() || null, session: session || null, args: null });
      onClose();
      openWhenListed(key);
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  };

  const label = harness === "shell" ? "Open a shell" : `Start ${HARNESSES.find((h) => h.id === harness)?.label}`;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink-900">
      <header className="safe-top flex shrink-0 items-center gap-1 px-1.5 pb-2">
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-ember-400 active:bg-ink-700">
          <X className="h-6 w-6" />
        </button>
        <h1 className="text-[18px] font-semibold text-mist-100">New session</h1>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {connected.length === 0 ? (
          <p className="mt-4 text-[14px] text-mist-400">No machine is connected.</p>
        ) : (
          <>
            <Label>Machine</Label>
            <div className="flex flex-wrap gap-2">
              {connected.map((h) => (
                <Chip key={h} on={h === host} onClick={() => setHost(h)}>
                  {name(h)}
                </Chip>
              ))}
            </div>

            <Label>Run</Label>
            <div className="grid grid-cols-4 gap-2">
              {HARNESSES.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setHarness(h.id)}
                  className={`flex flex-col items-center gap-1.5 rounded-xl px-1 py-3 ring-1 ${harness === h.id ? "bg-ink-700 ring-ember-400/60" : "bg-ink-800 ring-ink-700"}`}
                >
                  <HarnessBadge harness={h.id} size={28} />
                  <span className="text-[12.5px] font-medium text-mist-100">{h.label}</span>
                </button>
              ))}
            </div>

            <Label>Folder</Label>
            <div className="no-scrollbar flex gap-2 overflow-x-auto">
              {defaults[host] && (
                <Chip on={cwd === defaults[host]} onClick={() => void open(defaults[host]!)}>
                  <Star className="h-3.5 w-3.5 fill-current text-ember-400" /> {baseName(defaults[host]!)}
                </Chip>
              )}
              {home && (
                <Chip on={cwd === home} onClick={() => void open(home)}>
                  <Home className="h-3.5 w-3.5" /> Home
                </Chip>
              )}
              {recent.map((p) => (
                <Chip key={p} on={cwd === p} onClick={() => void open(p)}>
                  {baseName(p)}
                </Chip>
              ))}
            </div>
            <div className="mt-2 overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-ink-700">
              <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2.5">
                {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-mist-400" /> : <Folder className="h-4 w-4 shrink-0 text-ember-400" />}
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-mist-100">{pathTail(shortPath(cwd, home)) || "…"}</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {cwd && !isRoot(cwd) && (
                  <button onClick={() => void open(parentPath(cwd))} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] text-mist-300 active:bg-ink-700">
                    <CornerLeftUp className="h-4 w-4" /> Up
                  </button>
                )}
                {dirs.map((d) => (
                  <button
                    key={d.name}
                    onClick={() => void open(joinPath(cwd, d.name))}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] text-mist-100 active:bg-ink-700"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-mist-500" />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <ChevronLeft className="h-4 w-4 shrink-0 rotate-180 text-mist-600" />
                  </button>
                ))}
                {listing && dirs.length === 0 && <p className="px-3 py-2.5 text-[13px] text-mist-500">No folders here.</p>}
              </div>
            </div>

            {sessions.length > 0 && (
              <>
                <Label>tmux session</Label>
                <div className="flex flex-wrap gap-2">
                  <Chip on={session === ""} onClick={() => setSession("")}>
                    New
                  </Chip>
                  {sessions.map((s) => (
                    <Chip key={s} on={session === s} onClick={() => setSession(s)}>
                      {s}
                    </Chip>
                  ))}
                </div>
              </>
            )}

            <Label>Name (optional)</Label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={cwd ? baseName(cwd) : ""}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-xl bg-ink-800 px-3.5 py-3 text-[16px] text-mist-100 ring-1 ring-ink-700 outline-none focus:ring-ember-400/60"
            />
            {noTmux && <p className="mt-3 text-[13px] text-ember-300">{name(host)} has no tmux: install it there to start sessions from the phone.</p>}
            {error && <p className="mt-3 text-[13px] text-rose-400">{error}</p>}
          </>
        )}
      </main>

      <div className="safe-bottom shrink-0 border-t border-ink-700/80 px-4 pt-3">
        <button
          disabled={!cwd || creating || noTmux}
          onClick={() => void start()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-ember-400 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-40"
        >
          {creating && <Loader2 className="h-4 w-4 animate-spin" />}
          {label}
        </button>
      </div>
    </div>
  );
}
