// The navigation row of a folder browser: back / forward, the root (a drive or `/`) as a menu of
// places to jump to, the breadcrumbs, and a star that makes the current folder the default.

import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, HardDrive, Home, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { driveName, useDrives } from "../lib/drives";
import { hostLabel } from "../lib/hosts";
import { baseName, crumbsOf, isWithin, rootOf, sameFolder } from "../lib/paths";
import { useApp } from "../store/app";
import { useFiles } from "../store/files";

interface Props {
  host: string;
  path: string | null;
  onGo(path: string): void;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  /** Shown at the end of the row (git branch, a spinner, …). */
  trailing?: React.ReactNode;
}

export default function FolderNav({ host, path, onGo, canBack, canForward, onBack, onForward, trailing }: Props) {
  const def = useFiles((s) => s.defaults[host] ?? null);
  const machine = hostLabel(host);
  const root = path ? rootOf(path) : null;
  // The root crumb is the menu; the rest are plain crumbs.
  const crumbs = path ? crumbsOf(path).filter((c) => !sameFolder(c.path, root!)) : [];
  const isDefault = !!def && !!path && sameFolder(path, def);

  return (
    <div className="flex min-w-0 items-center gap-0.5 font-mono text-[11px] text-mist-500">
      <NavButton title="Back (Alt+←)" disabled={!canBack} onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton title="Forward (Alt+→)" disabled={!canForward} onClick={onForward}>
        <ArrowRight className="h-3.5 w-3.5" />
      </NavButton>
      {path && root && (
        <div className="ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5">
          <RootMenu host={host} path={path} root={root} onGo={onGo} />
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center">
              <ChevronRight className="h-3 w-3 text-mist-600" />
              <button
                onClick={() => onGo(c.path)}
                className={`rounded px-0.5 whitespace-nowrap hover:bg-ink-700 hover:text-mist-200 ${i === crumbs.length - 1 ? "text-mist-100" : ""}`}
              >
                {c.label}
              </button>
            </span>
          ))}
          <button
            onClick={() => useFiles.getState().setDefault(host, isDefault ? null : path)}
            title={isDefault ? `This is the default folder on ${machine} (click to clear)` : `Make this folder the default on ${machine}`}
            className={`ml-0.5 rounded p-0.5 transition-colors hover:bg-ink-700 ${isDefault ? "text-ember-400" : "text-mist-400 hover:text-ember-300"}`}
          >
            <Star className={`h-3.5 w-3.5 ${isDefault ? "fill-current" : ""}`} />
          </button>
        </div>
      )}
      {trailing && <div className="ml-auto flex shrink-0 items-center pl-1">{trailing}</div>}
    </div>
  );
}

function NavButton({ title, disabled, onClick, children }: { title: string; disabled: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-0.5 text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-100 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** The root crumb (`C:` or `/`): opens a menu of drives, home and the default folder. */
function RootMenu({ host, path, root, onGo }: { host: string; path: string; root: string; onGo(path: string): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const drives = useDrives(host) ?? [];
  const def = useFiles((s) => s.defaults[host] ?? null);
  const home = useApp((s) => s.hosts[host]?.facts?.home ?? null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const go = (p: string) => {
    setOpen(false);
    onGo(p);
  };
  const label = root === "/" ? "/" : root.slice(0, -1);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={root === "/" ? "Jump to…" : "Switch drive or jump to…"}
        className={`flex items-center gap-0.5 rounded px-1 ring-1 transition-colors hover:bg-ink-700 hover:text-mist-100 ${
          open ? "bg-ink-700 text-mist-100 ring-sky-400/50" : "text-mist-300 ring-ink-600"
        }`}
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="animate-rise absolute top-full left-0 z-40 mt-1 w-56 rounded-xl bg-ink-800 p-1 font-sans shadow-2xl ring-1 ring-ink-600">
          {def && (
            <Item icon={<Star className="h-3.5 w-3.5 fill-current text-ember-400" />} title={baseName(def)} hint={def} checked={sameFolder(path, def)} onClick={() => go(def)} />
          )}
          {home && <Item icon={<Home className="h-3.5 w-3.5" />} title="Home" hint={home} checked={sameFolder(path, home)} onClick={() => go(home)} />}
          <div className="my-1 h-px bg-ink-700" />
          {drives.length > 0 ? (
            drives.map((d) => (
              <Item
                key={d.path}
                icon={<HardDrive className="h-3.5 w-3.5" />}
                title={d.label}
                hint={driveName(d)}
                checked={isWithin(path, d.path)}
                onClick={() => go(d.path)}
              />
            ))
          ) : (
            <Item icon={<HardDrive className="h-3.5 w-3.5" />} title="/" hint="The root folder" checked={path === "/"} onClick={() => go("/")} />
          )}
        </div>
      )}
    </div>
  );
}

function Item({ icon, title, hint, checked, onClick }: { icon: React.ReactNode; title: string; hint?: string; checked?: boolean; onClick(): void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-ink-700">
      <span className="text-mist-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-mist-100">{title}</span>
        {hint && <span className="block truncate text-[10.5px] text-mist-500">{hint}</span>}
      </span>
      {checked && <Check className="h-3.5 w-3.5 shrink-0 text-sky-400" />}
    </button>
  );
}
