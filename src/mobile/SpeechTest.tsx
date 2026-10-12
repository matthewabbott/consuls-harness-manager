// A test of the browser's speech recognition in the Home Screen app (Apple's recognizer, through
// Safari): whether it's there, asks for the microphone, hears you, and how it reports. Temporary:
// the composer's mic button replaces it once it's known to work.

import { Copy, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type Recognition, recognizerClass } from "../lib/speech";
import { useApp } from "../store/app";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2 text-[13.5px]">
      <span className="flex-1 text-mist-400">{label}</span>
      <span className="font-mono text-mist-100">{value}</span>
    </div>
  );
}

export default function SpeechTest() {
  const found = recognizerClass();
  const Rec = found?.Rec ?? null;
  const which = found?.name ?? "none";
  const standalone = (navigator as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const [mic, setMic] = useState("…");
  useEffect(() => {
    navigator.permissions?.query({ name: "microphone" as PermissionName }).then(
      (s) => {
        setMic(s.state);
        s.onchange = () => setMic(s.state);
      },
      () => setMic("can't tell"),
    ) ?? setMic("can't tell");
  }, []);

  const [continuous, setContinuous] = useState(false);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState({ final: "", interim: "" });
  const [log, setLog] = useState<string[]>([]);
  const rec = useRef<Recognition | null>(null);
  const t0 = useRef(0);
  const add = (line: string) => setLog((l) => [...l.slice(-60), `${((performance.now() - t0.current) / 1000).toFixed(2)}s  ${line}`]);
  useEffect(() => () => rec.current?.abort(), []);

  const start = () => {
    if (!Rec) return;
    t0.current = performance.now();
    setLog([]);
    setText({ final: "", interim: "" });
    let r: Recognition;
    try {
      r = new Rec();
    } catch (e) {
      add(`new ${which}() threw: ${e}`);
      return;
    }
    r.lang = navigator.language;
    r.interimResults = true;
    r.continuous = continuous;
    r.maxAlternatives = 1;
    for (const ev of ["start", "audiostart", "soundstart", "speechstart", "speechend", "soundend", "audioend", "nomatch"]) r.addEventListener(ev, () => add(ev));
    r.onresult = (e) => {
      let final = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      setText({ final, interim });
      const last = e.results[e.results.length - 1];
      add(`result (index ${e.resultIndex} of ${e.results.length}, ${last.isFinal ? "final" : "interim"}): "${last[0].transcript}"`);
    };
    r.onerror = (e) => add(`error: ${e.error}${e.message ? ` (${e.message})` : ""}`);
    r.onend = () => {
      add("end");
      setListening(false);
      rec.current = null;
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
      add(`start() with lang ${r.lang}${continuous ? ", continuous" : ""}`);
    } catch (e) {
      add(`start() threw: ${e}`);
    }
  };

  const report = () =>
    [
      `api: ${which}`,
      `standalone: ${standalone}`,
      `language: ${navigator.language}`,
      `microphone: ${mic}`,
      `user agent: ${navigator.userAgent}`,
      `continuous: ${continuous}`,
      `heard: ${text.final}${text.interim ? ` [${text.interim}]` : ""}`,
      ...log,
    ].join("\n");

  return (
    <>
      <Row label="Speech recognition" value={which} />
      <Row label="Home Screen app" value={standalone ? "yes" : "no"} />
      <Row label="Language" value={navigator.language} />
      <Row label="Microphone permission" value={mic} />
      <div className="space-y-3 px-4 py-3">
        <label className="flex items-center gap-2 text-[14px] text-mist-300">
          <input type="checkbox" checked={continuous} disabled={listening} onChange={(e) => setContinuous(e.target.checked)} />
          Continuous (keep listening through pauses)
        </label>
        <button
          disabled={!Rec}
          onClick={() => (listening ? (rec.current?.stop(), add("stop()")) : start())}
          className={`flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[16px] font-semibold disabled:opacity-40 ${
            listening ? "bg-rose-500 text-white" : "bg-ember-400 text-ink-950"
          }`}
        >
          {listening ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-5 w-5" />}
          {listening ? "Stop" : "Start listening"}
        </button>
        <div className="min-h-12 rounded-xl bg-ink-900 px-3 py-2 text-[15px] leading-snug ring-1 ring-ink-700">
          <span className="text-mist-100">{text.final}</span>
          <span className="text-mist-500">{text.interim}</span>
          {!text.final && !text.interim && <span className="text-mist-600">What it hears shows here.</span>}
        </div>
        {log.length > 0 && (
          <>
            <pre className="selectable max-h-56 overflow-y-auto rounded-xl bg-ink-900 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-mist-300 ring-1 ring-ink-700">
              {log.join("\n")}
            </pre>
            <button
              onClick={() => void navigator.clipboard.writeText(report()).then(() => useApp.getState().notify("info", "Copied the test's results."))}
              className="flex items-center gap-1.5 text-[14px] text-ember-400"
            >
              <Copy className="h-4 w-4" /> Copy the results
            </button>
          </>
        )}
      </div>
    </>
  );
}
