// Settings → Dictation: the server's speech engine (Fluid Speech Mini) and how much memory it has
// right now, whether to use it (off: Safari's recognizer), live drafts, and the sound when
// recording stops (on or off, and how loud).

import { useEffect, useState } from "react";

import { livePref, onServerPref, setLivePref, setOnServerPref, useStt } from "../lib/dictation";
import { hangUpSound, hangUpVolume, previewHangUp, setHangUpSound, setHangUpVolume } from "../lib/sounds";

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange(on: boolean): void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${on ? "bg-jade-400" : "bg-ink-600"}`}
    >
      <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-[left] ${on ? "left-[22px]" : "left-[2px]"}`} />
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] text-mist-100">{title}</div>
        {hint && <div className="text-[12.5px] leading-snug text-mist-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export default function DictationSettings() {
  const status = useStt((s) => s.status);
  const [server, setServer] = useState(onServerPref);
  const [live, setLive] = useState(livePref);
  const [sound, setSound] = useState(hangUpSound);
  const [volume, setVolume] = useState(hangUpVolume);
  useEffect(() => useStt.getState().refresh(), []);

  const memory = !status ? (
    "Checking the server…"
  ) : !status.installed ? (
    "Not installed on the server (scripts/server.sh restart installs it)."
  ) : (
    <span className={status.level === "green" ? "text-jade-400" : status.level === "yellow" ? "text-amber-300" : "text-rose-300"}>
      {status.level === "green"
        ? `Plenty of memory (${status.availableMb ?? "?"} MB free).`
        : status.level === "yellow"
          ? `Memory is tight (${status.availableMb} MB free): pause every ${status.maxPieceSecs} s or so.`
          : status.level === "red"
            ? `Memory is very low (${status.availableMb} MB free): pause every ${status.maxPieceSecs} s or so.`
            : `Not enough memory right now (${status.availableMb} MB free): Safari's recognizer takes over.`}
    </span>
  );

  return (
    <>
      <Row title="Transcribe on the server" hint={server ? memory : "Off: Safari's recognizer listens instead (no punctuation)."}>
        <Switch
          on={server}
          label="Transcribe on the server"
          onChange={(on) => {
            setOnServerPref(on);
            setServer(on);
          }}
        />
      </Row>
      {server && (
        <Row
          title="Live text"
          hint={live ? "A draft of what you're saying, about once a second, while the server has memory to spare." : "Off: the text comes at each pause."}
        >
          <Switch
            on={live}
            label="Live text"
            onChange={(on) => {
              setLivePref(on);
              setLive(on);
            }}
          />
        </Row>
      )}
      <Row title="Sound when recording stops" hint="At the phone's volume; the silent switch mutes it.">
        <Switch
          on={sound}
          label="Sound when recording stops"
          onChange={(on) => {
            setHangUpSound(on);
            setSound(on);
          }}
        />
      </Row>
      {sound && (
        <Row title="Volume" hint="Plays when you let go.">
          <input
            type="range"
            aria-label="Volume of the sound when recording stops"
            min={0.1}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setHangUpVolume(v);
              setVolume(v);
            }}
            onPointerUp={previewHangUp}
            onKeyUp={previewHangUp}
            className="w-36 accent-jade-400"
          />
        </Row>
      )}
    </>
  );
}
