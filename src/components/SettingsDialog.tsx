import { Play, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { backend } from "../ipc/backend";
import type { AlertKind } from "../ipc/bindings/AlertKind";
import type { SoundPrefs } from "../ipc/bindings/SoundPrefs";
import { hostLabel } from "../lib/hosts";
import { useApp } from "../store/app";
import { setDefaultFolder, updateUiPrefs } from "../store/prefs";
import { useRedact } from "../store/recording";
import Modal, { Button } from "./Modal";

const KINDS: { key: keyof SoundPrefs; kind: AlertKind; label: string; hint: string }[] = [
  { key: "finished", kind: "finished", label: "Agent finished", hint: "A turn is done and it's your move" },
  { key: "needsInput", kind: "needsInput", label: "Needs your input", hint: "Permission prompts and questions" },
  { key: "subtask", kind: "subtask", label: "Subtask finished", hint: "A subagent completed (quiet tick)" },
  { key: "bell", kind: "bell", label: "Terminal bell", hint: "IRC highlights and other bells, in panes that ping on bell" },
];

export default function SettingsDialog() {
  const close = () => useApp.getState().setSettingsOpen(false);
  const saved = useApp((s) => s.config.sound);
  const [prefs, setPrefs] = useState<SoundPrefs>(saved);
  const { defaultFolders: defaults, recording, hideMachineNames } = useApp((s) => s.config.ui);
  const r = useRedact();
  const first = useRef(true);

  // Persist (debounced) as the user changes things — no Save button needed.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => backend().then((b) => b.setSoundPrefs(prefs)), 250);
    return () => clearTimeout(t);
  }, [prefs]);

  const set = <K extends keyof SoundPrefs>(k: K, v: SoundPrefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));
  const test = (kind: AlertKind) => backend().then((b) => b.testChime(kind, prefs.volume));

  return (
    <Modal title="Settings" onClose={close} width={480} footer={<Button onClick={close}>Done</Button>}>
      <div className="space-y-5">
        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-wide text-mist-400 uppercase">Notification sounds</div>
          <label className="flex items-center justify-between rounded-xl bg-ink-850 px-3.5 py-2.5 ring-1 ring-ink-700">
            <span className="text-[13px] text-mist-100">Play chimes</span>
            <Toggle on={prefs.enabled} onChange={(v) => set("enabled", v)} />
          </label>
          <div className={`mt-2 space-y-2 ${prefs.enabled ? "" : "pointer-events-none opacity-40"}`}>
            <div className="flex items-center gap-3 rounded-xl bg-ink-850 px-3.5 py-2.5 ring-1 ring-ink-700">
              <span className="w-16 text-[12.5px] text-mist-300">Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={prefs.volume}
                onChange={(e) => set("volume", Number(e.target.value))}
                onMouseUp={() => test("finished")}
                className="flex-1 accent-[var(--color-ember-400)]"
              />
              <span className="w-9 text-right font-mono text-[11px] text-mist-400">{Math.round(prefs.volume * 100)}%</span>
            </div>
            {KINDS.map((k) => (
              <div key={k.key} className="flex items-center gap-3 rounded-xl bg-ink-850 px-3.5 py-2.5 ring-1 ring-ink-700">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-mist-100">{k.label}</div>
                  <div className="text-[11px] text-mist-500">{k.hint}</div>
                </div>
                <button
                  onClick={() => test(k.kind)}
                  title="Play this chime"
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] text-mist-300 hover:bg-ink-700 hover:text-mist-100"
                >
                  <Play className="h-3 w-3" /> Test
                </button>
                <Toggle on={prefs[k.key] as boolean} onChange={(v) => set(k.key, v as never)} />
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-wide text-mist-400 uppercase">Windows notifications</div>
          <label className="flex items-center justify-between gap-3 rounded-xl bg-ink-850 px-3.5 py-2.5 ring-1 ring-ink-700">
            <div>
              <div className="text-[13px] text-mist-100">Show toasts when the app isn't focused</div>
              <div className="text-[11px] text-mist-500">Clicking a toast opens that pane.</div>
            </div>
            <Toggle on={prefs.toasts} onChange={(v) => set("toasts", v)} />
          </label>
        </section>

        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-wide text-mist-400 uppercase">Recording mode</div>
          <label className="flex items-center justify-between gap-3 rounded-xl bg-ink-850 px-3.5 py-2.5 ring-1 ring-ink-700">
            <div>
              <div className="text-[13px] text-mist-100">Hide personal details</div>
              <div className="text-[11px] text-mist-500">
                Your e-mail, tailnet names and IPs, user names and PC name are masked everywhere, including terminal text, and
                notifications stop naming panes. Also on the camera button in the left rail.
              </div>
            </div>
            <Toggle on={recording} onChange={(v) => updateUiPrefs({ recording: v })} />
          </label>
          <label className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-ink-850 px-3.5 py-2.5 ring-1 ring-ink-700">
            <div>
              <div className="text-[13px] text-mist-100">Also hide machine names</div>
              <div className="text-[11px] text-mist-500">Shown as “machine 1”, “machine 2”… (masked in terminal text).</div>
            </div>
            <Toggle on={hideMachineNames} onChange={(v) => updateUiPrefs({ hideMachineNames: v })} />
          </label>
        </section>

        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-wide text-mist-400 uppercase">Default folders</div>
          {Object.keys(defaults).length === 0 ? (
            <p className="rounded-xl bg-ink-850 px-3.5 py-2.5 text-[12px] leading-relaxed text-mist-400 ring-1 ring-ink-700">
              Where the Files explorer and the new-pane dialog start on each machine. Set one with the{" "}
              <Star className="inline h-3 w-3 align-[-1px]" /> in the explorer.
            </p>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(defaults).map(([host, path]) => (
                <div key={host} className="flex items-center gap-3 rounded-xl bg-ink-850 px-3.5 py-2 ring-1 ring-ink-700">
                  <span className="w-24 shrink-0 truncate text-[12.5px] text-mist-200">{r(hostLabel(host))}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist-400" title={r(path)}>
                    {r(path)}
                  </span>
                  <button
                    onClick={() => setDefaultFolder(host, null)}
                    className="rounded-lg px-2 py-1 text-[11.5px] text-mist-400 hover:bg-ink-700 hover:text-mist-100"
                  >
                    Clear
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-ember-400" : "bg-ink-600"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}
