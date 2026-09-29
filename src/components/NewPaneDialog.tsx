import { CornerLeftUp, Folder, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { backend } from "../ipc/backend";
import type { DirListing } from "../ipc/bindings/DirListing";
import type { Harness } from "../ipc/bindings/Harness";
import type { LocalShell } from "../ipc/bindings/LocalShell";
import { canBack, canForward, emptyHistory, pushHistory, stepHistory } from "../lib/history";
import { hostLabel, isLocal, shortPath } from "../lib/hosts";
import { isRoot, joinPath, parentPath, sameFolder } from "../lib/paths";
import { uiStorage } from "../lib/uiState";
import { useApp } from "../store/app";
import { useRedact } from "../store/recording";
import FolderNav from "./FolderNav";
import HarnessBadge from "./HarnessBadge";
import Modal, { Button } from "./Modal";
import PlacesBar from "./PlacesBar";

const HARNESSES: { id: Harness; label: string; hint: string }[] = [
  { id: "claude", label: "Claude Code", hint: "claude" },
  { id: "codex", label: "Codex", hint: "codex" },
  { id: "omp", label: "omp", hint: "oh-my-pi" },
  { id: "shell", label: "Shell", hint: "just a terminal" },
];

const LAST_HARNESS = "consuls.newPane.harness";
const LAST_SHELL = "consuls.newPane.localShell";
/** Session choice meaning "no tmux: a plain shell on its own connection". */
const DIRECT = "\u0000direct";

function loadLastHarness(): Harness {
  const v = uiStorage.getItem(LAST_HARNESS) as Harness | null;
  return v && HARNESSES.some((h) => h.id === v) ? v : "claude";
}

export default function NewPaneDialog() {
  const preselect = useApp((s) => s.newPaneFor);
  const startIn = useApp((s) => s.newPaneCwd);
  const close = useApp((s) => s.closeNewPane);
  const hosts = useApp((s) => s.hosts);
  const panes = useApp((s) => s.panes);
  const connected = Object.values(hosts).filter((h) => h.phase.phase === "connected").map((h) => h.id);

  const [host, setHost] = useState<string>(() => (preselect && connected.includes(preselect) ? preselect : (connected[0] ?? "")));
  const [harness, setHarness] = useState<Harness>(loadLastHarness);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [name, setName] = useState("");
  const [args, setArgs] = useState("");
  const [session, setSession] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const red = useRedact();

  const home = hosts[host]?.facts?.home ?? "";
  const hostPanes = panes[host] ?? [];

  // Recent working directories of panes already on this host.
  const recent = useMemo(() => {
    const seen = new Set<string>();
    for (const p of hostPanes) if (p.currentPath && p.currentPath !== home) seen.add(p.currentPath);
    return [...seen].slice(0, 6);
  }, [hostPanes, home]);
  const sessions = useMemo(() => [...new Set(hostPanes.flatMap((p) => (p.tmux ? [p.tmux.sessionName] : [])))], [hostPanes]);
  const local = isLocal(host);
  // Machines without tmux can still run plain shells (This PC gets tmux through Cygwin).
  const noTmux = !!hosts[host]?.facts && !hosts[host]?.facts?.tmuxVersion;
  const direct = noTmux || session === DIRECT;
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [shell, setShell] = useState<string>(() => uiStorage.getItem(LAST_SHELL) ?? "");
  useEffect(() => {
    if (local && shells.length === 0) void backend().then((b) => b.localShells()).then(setShells);
  }, [local, shells.length]);
  const shellId = shells.some((s) => s.id === shell) ? shell : (shells[0]?.id ?? "");

  const [history, setHistory] = useState(emptyHistory<string>);
  /** Shows `path`; `record: false` for back / forward. */
  const open = async (path: string, record = true) => {
    if (!host) return;
    setLoading(true);
    setError(null);
    try {
      const l = await (await backend()).listDir(host, path);
      setListing(l);
      setPathInput(l.path);
      if (record) setHistory((h) => pushHistory(h, l.path, sameFolder));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  const step = (delta: -1 | 1) => {
    const next = stepHistory(history, delta);
    if (!next) return;
    setHistory(next.history);
    void open(next.entry, false);
  };

  useEffect(() => {
    setListing(null);
    setHistory(emptyHistory());
    setSession("");
    if (host) void open(host === preselect && startIn ? startIn : (useApp.getState().config.ui.defaultFolders[host] ?? recent[0] ?? "~"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const cwd = listing?.path ?? "";
  const dirs = (listing?.entries ?? []).filter((e) => e.isDir && (showHidden || !e.name.startsWith(".")));

  const create = async () => {
    if (!host || !cwd) return;
    setCreating(true);
    setError(null);
    try {
      uiStorage.setItem(LAST_HARNESS, harness);
      if (local && shellId) uiStorage.setItem(LAST_SHELL, shellId);
      const key = await (await backend()).createPane({
        host,
        cwd,
        harness,
        name: direct ? null : name.trim() || null,
        session: direct ? null : session || null,
        args: args.trim() || null,
        direct: direct || undefined,
        shell: local && direct ? shellId || undefined : undefined,
      });
      close();
      useApp.getState().setExpanded(key);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      title="New pane"
      onClose={close}
      width={640}
      footer={
        <>
          {error && <span className="mr-auto truncate text-[12px] text-rose-400">{red(error)}</span>}
          <Button onClick={close}>Cancel</Button>
          <Button kind="primary" onClick={create} disabled={!cwd || creating}>
            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {harness === "shell" ? "Open shell" : `Start ${HARNESSES.find((h) => h.id === harness)?.label}`}
          </Button>
        </>
      }
    >
      {connected.length === 0 ? (
        <p className="text-[13px] text-mist-400">Connect a machine first.</p>
      ) : (
        <div className="space-y-4">
          <Field label="Machine">
            <div className="flex flex-wrap gap-1.5">
              {connected.map((h) => (
                <Chip key={h} on={h === host} onClick={() => setHost(h)}>
                  {red(hostLabel(h))}
                </Chip>
              ))}
            </div>
          </Field>

          <Field label="Run">
            <div className="grid grid-cols-4 gap-2">
              {HARNESSES.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setHarness(h.id)}
                  className={`flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 ring-1 transition-colors ${
                    harness === h.id ? "bg-ink-700 ring-sky-400/60" : "bg-ink-850 ring-ink-700 hover:bg-ink-750"
                  }`}
                >
                  <HarnessBadge harness={h.id} size={26} />
                  <span className="text-[12px] font-medium text-mist-100">{h.label}</span>
                  <span className="text-[10.5px] text-mist-500">{h.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          {local && direct && shells.length > 0 && (
            <Field label="Shell">
              <div className="flex flex-wrap gap-1.5">
                {shells.map((s) => (
                  <Chip key={s.id} on={s.id === shellId} onClick={() => setShell(s.id)}>
                    <span title={s.path}>{s.name}</span>
                  </Chip>
                ))}
              </div>
            </Field>
          )}

          <Field label="Working directory">
            <div className="mb-2">
              <PlacesBar host={host} path={cwd || null} onGo={(p) => void open(p)} />
            </div>
            {recent.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {recent.map((r) => (
                  <Chip key={r} on={r === cwd} onClick={() => open(r)} mono>
                    {red(shortPath(r, home))}
                  </Chip>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void open(pathInput.trim());
              }}
              className="flex gap-2"
            >
              <input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                spellCheck={false}
                className="personal min-w-0 flex-1 rounded-lg bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-mist-100 ring-1 ring-ink-600 outline-none focus:ring-sky-400/60"
              />
              <Button type="submit">Go</Button>
            </form>
            <div className="mt-2 overflow-hidden rounded-xl bg-ink-900/70 ring-1 ring-ink-700">
              <div
                className="border-b border-ink-700 px-1.5 py-1.5"
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.preventDefault();
                    step(e.key === "ArrowLeft" ? -1 : 1);
                  }
                }}
              >
                <FolderNav
                  host={host}
                  path={cwd || null}
                  onGo={(p) => void open(p)}
                  canBack={canBack(history)}
                  canForward={canForward(history)}
                  onBack={() => step(-1)}
                  onForward={() => step(1)}
                  trailing={loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-mist-500" />}
                />
              </div>
              <div className="scroll-thin h-52 overflow-y-auto p-1">
                {cwd && !isRoot(cwd) && (
                  <DirRow onClick={() => open(parentPath(cwd))}>
                    <CornerLeftUp className="h-3.5 w-3.5 text-mist-500" /> ..
                  </DirRow>
                )}
                {dirs.map((d) => (
                  <DirRow key={d.name} onClick={() => open(joinPath(cwd, d.name))}>
                    <Folder className="h-3.5 w-3.5 text-sky-400/80" /> {red(d.name)}
                  </DirRow>
                ))}
                {listing && dirs.length === 0 && <div className="px-3 py-2 text-[12px] text-mist-500">No subfolders.</div>}
              </div>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-mist-500">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden folders
            </label>
          </Field>

          <div className={`grid grid-cols-2 gap-3 ${local && noTmux ? "hidden" : ""}`}>
            <Field label="Name (optional)">
              <input
                value={name}
                disabled={direct}
                onChange={(e) => setName(e.target.value)}
                placeholder={cwd ? `${red(cwd.split("/").pop() ?? "")}${harness === "shell" ? "" : `-${harness}`}` : ""}
                className="w-full rounded-lg bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-mist-100 ring-1 ring-ink-600 outline-none placeholder:text-mist-500 focus:ring-sky-400/60"
              />
            </Field>
            <Field label="tmux session">
              <select
                value={noTmux ? DIRECT : session}
                disabled={noTmux}
                title={noTmux ? `tmux isn't installed on ${red(hostLabel(host))}` : undefined}
                onChange={(e) => setSession(e.target.value)}
                className="w-full rounded-lg bg-ink-900 px-2 py-1.5 text-[12.5px] text-mist-100 ring-1 ring-ink-600 outline-none disabled:opacity-60"
              >
                <option value="">New session</option>
                {sessions.map((s) => (
                  <option key={s} value={s}>
                    Add window to {s}
                  </option>
                ))}
                <option value={DIRECT}>No tmux (plain shell)</option>
              </select>
            </Field>
          </div>
          {direct && !local && (
            <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-[11.5px] leading-snug text-rose-200/90 ring-1 ring-rose-500/25">
              {noTmux && <>tmux isn't installed on {red(host)}, so this opens a plain shell. </>}A plain shell runs on this connection only:
              it's lost if the connection drops or Harness Manager quits, and it's never revived. Handy for <span className="font-mono">tmux attach</span> / <span className="font-mono">Ctrl+b d</span> or a
              quick look around.
            </p>
          )}
          {harness !== "shell" && (
            <Field label="Extra arguments (optional)">
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={harness === "claude" ? "--model opus  or  --resume" : harness === "codex" ? "--model gpt-5.6-sol" : ""}
                spellCheck={false}
                className="w-full rounded-lg bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-mist-100 ring-1 ring-ink-600 outline-none placeholder:text-mist-500 focus:ring-sky-400/60"
              />
            </Field>
          )}
          {harness === "claude" && (
            <p className="text-[11px] leading-snug text-mist-500">
              Claude Code only runs Consuls' notification hooks once the folder is trusted — accept its trust prompt in the pane if it
              asks.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-400 uppercase">{label}</div>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children, mono }: { on: boolean; onClick(): void; children: React.ReactNode; mono?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-[12px] ring-1 transition-colors ${mono ? "font-mono text-[11.5px]" : ""} ${
        on ? "bg-sky-400/15 text-sky-400 ring-sky-400/50" : "bg-ink-850 text-mist-300 ring-ink-700 hover:bg-ink-750"
      }`}
    >
      {children}
    </button>
  );
}

function DirRow({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[12.5px] text-mist-200 hover:bg-ink-700">
      {children}
    </button>
  );
}
