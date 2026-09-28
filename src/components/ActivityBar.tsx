import { Files, Server, Settings, Video } from "lucide-react";

import { useApp } from "../store/app";
import { useUi, type SidebarTab } from "../store/ui";

interface Tab {
  id: SidebarTab;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

/** VS Code–style rail: switches (or collapses) the left sidebar's panel. */
export default function ActivityBar() {
  const tab = useUi((s) => s.sidebarTab);
  const collapsed = useUi((s) => s.sidebarCollapsed || s.maximized);
  const show = useUi((s) => s.showSidebarTab);
  const recording = useUi((s) => s.recording);
  const waiting = useApp((s) => Object.values(s.attention).filter((a) => a.attention === "unacked").length);

  const tabs: Tab[] = [
    { id: "machines", label: "Machines & panes", icon: <Server className="h-[18px] w-[18px]" />, badge: waiting },
    { id: "files", label: "Files", icon: <Files className="h-[18px] w-[18px]" /> },
  ];

  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-ink-700/80 bg-ink-950/70 py-2.5">
      <button
        onClick={() => useUi.getState().toggleSidebar()}
        title={collapsed ? "Show sidebar (Ctrl+Shift+B)" : "Hide sidebar (Ctrl+Shift+B)"}
        className="mb-2 rounded-lg p-1 transition-opacity hover:opacity-80"
      >
        <img src="/app-icon.svg" alt="Consul's Harness Manager" className="h-7 w-7" />
      </button>
      {tabs.map((t) => {
        const active = t.id === tab && !collapsed;
        return (
          <button
            key={t.id}
            onClick={() => show(t.id)}
            title={t.label}
            className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              active ? "bg-ink-700/80 text-mist-100" : "text-mist-500 hover:bg-ink-800 hover:text-mist-200"
            }`}
          >
            {active && <span className="absolute top-2 bottom-2 -left-1 w-0.5 rounded-full bg-ember-400" />}
            {t.icon}
            {!!t.badge && (
              <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-ember-400 px-1 text-center font-mono text-[9.5px] leading-4 font-bold text-ink-950">
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        onClick={() => useUi.getState().setRecording(!recording)}
        title={
          recording
            ? "Recording mode is on: your e-mail, IPs, user names and PC name are hidden (click to show them)"
            : "Recording mode: hide your e-mail, IPs, user names and PC name, for screenshots and videos"
        }
        className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          recording ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40" : "text-mist-500 hover:bg-ink-800 hover:text-mist-200"
        }`}
      >
        <Video className="h-[18px] w-[18px]" />
        {recording && <span className="absolute top-1.5 right-1.5 h-2 w-2 animate-breathe rounded-full bg-rose-400" />}
      </button>
      <button
        onClick={() => useApp.getState().setSettingsOpen(true)}
        title="Settings"
        className="flex h-10 w-10 items-center justify-center rounded-lg text-mist-500 transition-colors hover:bg-ink-800 hover:text-mist-200"
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>
    </nav>
  );
}
