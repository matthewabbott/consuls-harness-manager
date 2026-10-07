// Where you are in a folder on the phone, and how to get elsewhere: back / forward, the path as
// breadcrumbs (tap a parent to jump there; tap the current folder, or ✎, to type a path), and
// places (the machine's default folder, home, the root).

import { ArrowLeft, ArrowRight, ChevronRight, Home, Pencil, Star } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";

import { baseName, homeCrumbs, resolveTyped, rootOf, sameFolder, typedPath } from "../lib/paths";
import { setDefaultFolder, useDefaultFolder } from "../store/prefs";
import Chip from "./Chip";
import type { Folder } from "../lib/useFolder";

function NavButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button aria-label={label} disabled={disabled} onClick={onClick} className="shrink-0 rounded-full p-2 text-mist-200 active:bg-ink-700 disabled:text-mist-700">
      {children}
    </button>
  );
}

export default function FolderBar({ folder, home }: { folder: Folder; home: string | null }) {
  const [editing, setEditing] = useState(false);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const path = folder.path;
  // The end of the path (where you are) shows first.
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editing]);
  const crumbs = path ? homeCrumbs(path, home) : [];

  return (
    <div className="flex items-center gap-0.5">
      <NavButton label="Back" disabled={!folder.canBack} onClick={folder.back}>
        <ArrowLeft className="h-5 w-5" />
      </NavButton>
      <NavButton label="Forward" disabled={!folder.canForward} onClick={folder.forward}>
        <ArrowRight className="h-5 w-5" />
      </NavButton>
      {editing && path ? (
        <PathField
          initial={typedPath(path, home)}
          onGo={(typed) => {
            setEditing(false);
            const target = resolveTyped(typed, path);
            if (target && !sameFolder(target, path)) folder.go(target);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="ml-0.5 flex min-w-0 flex-1 items-center rounded-xl bg-ink-850 ring-1 ring-ink-700">
          <div ref={crumbsRef} className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto py-0.5 pl-1">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={c.path}>
                  {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-mist-600" />}
                  <button
                    onClick={() => (last ? setEditing(true) : folder.go(c.path))}
                    className={`shrink-0 rounded-lg px-1.5 py-1.5 font-mono text-[14px] whitespace-nowrap active:bg-ink-700 ${last ? "font-medium text-mist-100" : "text-mist-400"}`}
                  >
                    {c.label}
                  </button>
                </Fragment>
              );
            })}
            {/* The rest of the bar: tap to type. */}
            <button aria-label="Type a path" onClick={() => setEditing(true)} className="h-9 min-w-6 flex-1" />
          </div>
          <button aria-label="Type a path" onClick={() => setEditing(true)} className="shrink-0 p-2 text-mist-500 active:text-mist-200">
            <Pencil className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function PathField({ initial, onGo, onCancel }: { initial: string; onGo(typed: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // At the end: typing goes on from the folder you're in.
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollLeft = el.scrollWidth;
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onGo(value);
      }}
      className="ml-0.5 flex min-w-0 flex-1 items-center gap-0.5"
    >
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        enterKeyHint="go"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Folder path"
        className="personal min-w-0 flex-1 rounded-xl bg-ink-800 px-2.5 py-1.5 font-mono text-[16px] text-mist-100 ring-1 ring-sky-400/50 outline-none"
      />
      {/* Keeps the field focused (its blur would cancel). */}
      <button type="submit" onMouseDown={(e) => e.preventDefault()} className="shrink-0 rounded-full px-2 py-1.5 text-[15px] font-medium text-ember-400 active:bg-ink-700">
        Go
      </button>
    </form>
  );
}

/** One-tap places: the default folder, home, `extra` (e.g. where agents are working), the root; ☆ sets the default. */
export function Places({ host, path, home, extra = [], onGo }: { host: string; path: string | null; home: string | null; extra?: string[]; onGo(path: string): void }) {
  const def = useDefaultFolder(host);
  const isDefault = !!def && !!path && sameFolder(path, def);
  const root = path ? rootOf(path) : "/";
  return (
    <div className="no-scrollbar flex items-center gap-2 overflow-x-auto">
      {def && (
        <Chip on={isDefault} onClick={() => onGo(def)}>
          <Star className="h-3.5 w-3.5 fill-current text-ember-400" /> {baseName(def)}
        </Chip>
      )}
      {home && (
        <Chip on={!!path && sameFolder(path, home)} onClick={() => onGo(home)}>
          <Home className="h-3.5 w-3.5" /> Home
        </Chip>
      )}
      {extra
        .filter((p) => p !== def && p !== home)
        .map((p) => (
          <Chip key={p} on={!!path && sameFolder(path, p)} onClick={() => onGo(p)}>
            {baseName(p)}
          </Chip>
        ))}
      <Chip on={!!path && sameFolder(path, root)} onClick={() => onGo(root)}>
        <span className="font-mono">{root === "/" ? "/" : root.slice(0, -1)}</span>
      </Chip>
      {path && (
        <button
          onClick={() => setDefaultFolder(host, isDefault ? null : path)}
          aria-label={isDefault ? "Stop using this folder as the default" : "Make this folder the default"}
          className={`ml-auto shrink-0 rounded-full p-2 active:bg-ink-700 ${isDefault ? "text-ember-400" : "text-mist-500"}`}
        >
          <Star className={`h-4.5 w-4.5 ${isDefault ? "fill-current" : ""}`} />
        </button>
      )}
    </div>
  );
}
