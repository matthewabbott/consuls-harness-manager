// tmux prefix keys (Ctrl+B …) in the expanded view of a tmux pane: see term/tmuxPrefix.ts.

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";
import { useApp } from "../store/app";
import { useUi } from "../store/ui";
import { nextPaneTarget, PREFIX_HELP, prefixAction, prefixLabel, windowTarget, type WindowPane } from "../term/tmuxPrefix";

type RenameWhat = "window" | "session";

/** Opens a pane as soon as it's listed (a new window or split takes a moment to show up). */
function openWhenListed(key: number) {
  const listed = () => Object.values(useApp.getState().panes).flat().some((p) => p.key === key);
  const open = () => {
    void backend().then((b) => b.ackPane(key));
    useApp.getState().setExpanded(key);
  };
  if (listed()) return open();
  const timer = setTimeout(() => unsubscribe(), 5000);
  const unsubscribe = useApp.subscribe(() => {
    if (!listed()) return;
    unsubscribe();
    clearTimeout(timer);
    open();
  });
}

/** The panes of `pane`'s tmux session (grouped sessions share their windows). */
function sessionPanes(pane: PaneInfo): WindowPane[] {
  const t = pane.tmux!;
  return Object.values(useApp.getState().panes)
    .flat()
    .filter((p) => p.host === pane.host && p.tmux && (p.tmux.sessionId === t.sessionId || (t.sessionGroup !== null && p.tmux.sessionGroup === t.sessionGroup)))
    .map((p) => ({ key: p.key, windowIndex: p.tmux!.windowIndex, paneIndex: p.tmux!.paneIndex, paneActive: p.tmux!.paneActive }));
}

export function usePrefixKeys(pane: PaneInfo, back: () => void) {
  const [pending, setPending] = useState(false);
  const [help, setHelp] = useState(false);
  const [renaming, setRenaming] = useState<RenameWhat | null>(null);
  const prefix = pane.tmux?.prefix ?? null;

  const onKey = (key: string, tmuxName: string | null) => {
    if (!prefix || !pane.tmux) return;
    const label = prefixLabel(prefix);
    const notify = (msg: string) => useApp.getState().notify("info", msg);
    const fail = (e: unknown) => useApp.getState().notify("warning", `tmux: ${e instanceof Error ? e.message : String(e)}`);
    const show = (target: number | null, missing: string) => (target === null ? notify(missing) : openWhenListed(target));
    const me: WindowPane = { key: pane.key, windowIndex: pane.tmux.windowIndex, paneIndex: pane.tmux.paneIndex, paneActive: pane.tmux.paneActive };
    const action = prefixAction(key, tmuxName, prefix);
    switch (action.kind) {
      case "sendPrefix":
        void backend().then((b) => b.sendKeys(pane.key, [prefix]));
        break;
      case "grid":
        back();
        break;
      case "newWindow":
      case "split": {
        const op = action.kind === "newWindow" ? ({ kind: "newWindow" } as const) : ({ kind: "split", horizontal: action.horizontal } as const);
        void backend()
          .then((b) => b.tmuxOp(pane.key, op))
          .then((k) => k !== null && openWhenListed(k), fail);
        break;
      }
      case "close":
        useApp.getState().setTerminating(pane.key);
        break;
      case "zoom":
        useUi.getState().setMaximized(!useUi.getState().maximized);
        break;
      case "window":
        show(windowTarget(sessionPanes(pane), me, action.which), `This session has no window ${action.which}.`);
        break;
      case "nextPane":
        show(nextPaneTarget(sessionPanes(pane), me), "This window has only one pane.");
        break;
      case "rename":
        setRenaming(action.what);
        break;
      case "help":
        setHelp((h) => !h);
        break;
      case "cancel":
        break;
      case "unknown":
        notify(`${label} ${key} isn't one of the tmux keys Consuls handles; ${label} ? lists them.`);
        break;
    }
  };

  return { prefix, pending, setPending, help, setHelp, renaming, setRenaming, onKey };
}

/** Shown in the header while the prefix waits for its key. */
export function PrefixPending({ prefix }: { prefix: string }) {
  return (
    <span className="shrink-0 rounded-md bg-sky-400/15 px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-sky-300 ring-1 ring-sky-400/40" title="tmux prefix: press a key (? lists them, Esc cancels)">
      {prefixLabel(prefix)} …
    </span>
  );
}

/** The Ctrl+B ? sheet. */
export function PrefixHelp({ prefix, onClose }: { prefix: string; onClose(): void }) {
  const label = prefixLabel(prefix);
  return (
    <div className="animate-rise absolute top-12 right-5 z-30 w-80 rounded-xl bg-ink-800 p-3 shadow-2xl ring-1 ring-ink-600">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-mist-100">
        tmux keys: {label}, then…
        <button onClick={onClose} className="ml-auto rounded-md p-0.5 text-mist-500 hover:bg-ink-700 hover:text-mist-100" title="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {PREFIX_HELP.map(([keys, what]) => (
            <tr key={keys}>
              <td className="py-0.5 pr-3 font-mono whitespace-nowrap text-sky-300">{keys}</td>
              <td className="py-0.5 text-mist-300">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ctrl+B , and Ctrl+B $: tmux's own window / session name. */
export function TmuxRenameField({ pane, what, onDone }: { pane: PaneInfo; what: RenameWhat; onDone(): void }) {
  const [value, setValue] = useState(() => (what === "window" ? pane.tmux?.windowName : pane.tmux?.sessionName) ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = () => {
    const name = value.trim();
    if (name) {
      const op = what === "window" ? ({ kind: "renameWindow", name } as const) : ({ kind: "renameSession", name } as const);
      void backend()
        .then((b) => b.tmuxOp(pane.key, op))
        .catch((e) => useApp.getState().notify("warning", `tmux: ${e instanceof Error ? e.message : String(e)}`));
    }
    onDone();
  };
  return (
    <label className="flex items-center gap-2 font-mono text-[11px] text-mist-400">
      {what === "window" ? "tmux window" : "tmux session"}
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        aria-label={what === "window" ? "tmux window name" : "tmux session name"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") onDone();
        }}
        onBlur={onDone}
        className="w-56 rounded-md bg-ink-900 px-2 py-0.5 text-[12px] text-mist-100 ring-1 ring-sky-400/60 outline-none"
      />
    </label>
  );
}
