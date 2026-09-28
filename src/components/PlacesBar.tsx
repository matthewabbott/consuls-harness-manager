// One-click places for a folder browser: the machine's default folder, home, and its drives
// (This PC on Windows) or `/`.

import { Home, Star } from "lucide-react";

import { useDrives, driveName } from "../lib/drives";
import { hostLabel } from "../lib/hosts";
import { baseName, isWithin, sameFolder } from "../lib/paths";
import { useApp } from "../store/app";
import { useFiles } from "../store/files";
import { useRedact } from "../store/recording";

export default function PlacesBar({ host, path, onGo }: { host: string; path: string | null; onGo(path: string): void }) {
  const def = useFiles((s) => s.defaults[host] ?? null);
  const home = useApp((s) => s.hosts[host]?.facts?.home ?? null);
  const known = useDrives(host);
  const r = useRedact();
  const drives = known ?? [];

  // Exactly one chip lights up: the most specific place the current folder is.
  const active =
    path === null
      ? null
      : def && sameFolder(path, def)
        ? "default"
        : home && sameFolder(path, home)
          ? "home"
          : (drives.find((d) => isWithin(path, d.path))?.path ?? (drives.length === 0 && sameFolder(path, "/") ? "/" : null));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {def && (
        <Place on={active === "default"} onClick={() => onGo(def)} title={r(`Default folder on ${hostLabel(host)}: ${def}`)}>
          <Star className="h-3 w-3 fill-current text-ember-400" />
          <span className="max-w-28 truncate">{r(baseName(def))}</span>
        </Place>
      )}
      {home && (
        <Place on={active === "home"} onClick={() => onGo(home)} title={r(`Home: ${home}`)}>
          <Home className="h-3 w-3" />
        </Place>
      )}
      {drives.map((d) => (
        <Place key={d.path} on={active === d.path} onClick={() => onGo(d.path)} title={`${d.label} · ${driveName(d)}`}>
          <span className="font-mono">{d.label}</span>
        </Place>
      ))}
      {known?.length === 0 && (
        <Place on={active === "/"} onClick={() => onGo("/")} title="The root folder">
          <span className="font-mono">/</span>
        </Place>
      )}
    </div>
  );
}

function Place({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ring-1 transition-colors ${
        on ? "bg-sky-400/15 text-sky-300 ring-sky-400/50" : "bg-ink-850 text-mist-300 ring-ink-700 hover:bg-ink-750 hover:text-mist-100"
      }`}
    >
      {children}
    </button>
  );
}
