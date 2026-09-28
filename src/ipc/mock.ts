// A fake core for running the UI in a plain browser: a few hosts, panes with plausible
// agent output, one pane that keeps "working", and a host awaiting Tailscale approval.

import type { Backend } from "./backend";
import type { CoreEvent } from "./bindings/CoreEvent";
import type { CoreSnapshot } from "./bindings/CoreSnapshot";
import type { FocusState } from "./bindings/FocusState";
import type { PaneAttention } from "./bindings/PaneAttention";
import type { SoundPrefs } from "./bindings/SoundPrefs";
import type { HostConfig } from "./bindings/HostConfig";
import type { LabelDef } from "./bindings/LabelDef";
import { mockFsCount, mockFsOp, mockGitStatus, mockListDir } from "./mockFs";
import type { HostState } from "./bindings/HostState";
import type { IntegrationStatus } from "./bindings/IntegrationStatus";
import type { PaneInfo } from "./bindings/PaneInfo";
import type { TmuxLoc } from "./bindings/TmuxLoc";
import type { TailnetPeer } from "./bindings/TailnetPeer";
import { FRAME_RAW, FRAME_RESET, FRAME_TILE, encodeFrame, encodeTile, type TileRun, type TileSnapshot } from "./frames";

const P = (n: number) => 0x0100_0000 | n;

type Seg = [string, number?, number?]; // text, fg, attrs

function line(segs: Seg[]): TileRun[] {
  const runs: TileRun[] = [];
  let col = 0;
  for (const [text, fg = 0, attrs = 0] of segs) {
    const cells = [...text].length;
    runs.push({ start: col, cells, fg, bg: 0, attrs, text });
    col += cells;
  }
  return runs;
}

function screen(cols: number, rows: number, lines: Seg[][], cursor: [number, number] | null): TileSnapshot {
  const padded = lines.slice(-rows);
  while (padded.length < rows) padded.push([]);
  return {
    cols,
    rows,
    cursorX: cursor?.[0] ?? 0,
    cursorY: cursor?.[1] ?? 0,
    cursorVisible: cursor !== null,
    altScreen: false,
    lines: padded.map((segs) => line(segs)),
  };
}

const claudeLines: Seg[][] = [
  [["> refactor the session supervisor so reconnects re-seed panes", P(8)]],
  [],
  [["⏺ ", P(4)], ["I'll start by reading the supervisor and the seed path."]],
  [],
  [["⏺ ", P(2)], ["Read", 0, 1], ["(crates/chm-core/src/hub/host.rs)", P(8)]],
  [["  ⎿  Read 212 lines", P(8)]],
  [["⏺ ", P(2)], ["Update", 0, 1], ["(crates/chm-core/src/hub/tmux_mgr.rs)", P(8)]],
  [["  ⎿  Updated with 14 additions and 3 removals", P(8)]],
  [["     118 ", P(8)], ["+        self.seed(pane, \"continue\").await;", P(2)]],
  [["     119 ", P(8)], ["-        self.resume(pane).await;", P(1)]],
  [],
  [["⏺ ", P(4)], ["Reconnects now re-attach and re-seed every pane; the live test"]],
  [["  passes 8 consecutive seeds under load with no divergence."]],
  [],
  [["╭────────────────────────────────────────────────────────────────╮", P(8)]],
  [["│ ", P(8)], ["> ", 0, 1], ["                                                             │", P(8)]],
  [["╰────────────────────────────────────────────────────────────────╯", P(8)]],
  [["  ⏵⏵ accept edits on (shift+tab to cycle)", P(5)]],
];

const codexLines: Seg[][] = [
  [["› ", P(6)], ["add a tile painter that scales the terminal to fit"]],
  [],
  [["• ", P(2)], ["Explored", 0, 1]],
  [["  └ Read tilePainter.ts, palette.ts", P(8)]],
  [["• ", P(2)], ["Edited src/term/tilePainter.ts (+84 -0)", 0, 1]],
  [["    12 +export function layoutFor(snap, width, height) {", P(2)]],
  [["    13 +  const cellW = width / Math.max(snap.cols, 1);", P(2)]],
  [],
  [["• ", P(2)], ["Ran npx vitest run", 0, 1]],
  [["  └ ✓ src/ipc/frames.test.ts (3 tests) 4ms", P(2)]],
  [],
  [["─ Worked for 1m 12s ───────────────────────────────────────────", P(8)]],
  [],
  [["› ", P(6)], ["Implement {feature}", P(8)]],
  [],
  [["  gpt-5.6-sol high · 71% context left · ~/code/consuls", P(8)]],
];

const ompLines: Seg[][] = [
  [[" Record corrected and pushed: 73519da, 274 tests green."]],
  [],
  [[" Corrected final status:", 0, 1]],
  [[" - Criterion 1: ", 0, 0], ["NOT MET", P(1), 1], [" as written — both arms scored 19/52."]],
  [[" - Criteria 2–4: ", 0, 0], ["MET", P(2), 1], [" — tuned run launched with evidence."]],
  [],
  [[" ⓘ Advisor note", P(3)]],
  [["   ▎ Use alias `bandits` from the verified quote instead.", P(8)]],
  [],
  [[" π > ◒ K3 👁 > 📁 ~/terrarium > ⑂ feature/v2 ▶─7%───────────┃──1M─", P(5)]],
];

const shellLines: Seg[][] = [
  [["consulear@spark2", P(10), 1], [":"], ["~/models", P(12), 1], ["$ nvidia-smi --query-gpu=utilization.gpu --format=csv"]],
  [["utilization.gpu [%]"]],
  [["97 %"]],
  [["consulear@spark2", P(10), 1], [":"], ["~/models", P(12), 1], ["$ "]],
];

interface MockPane {
  info: PaneInfo;
  lines: Seg[][];
  cursor: [number, number] | null;
}

type PaneExtra = Partial<Omit<PaneInfo, "tmux">> & { tmux?: Partial<TmuxLoc> | null };

function pane(key: number, host: string, extra: PaneExtra, lines: Seg[][], cursor: [number, number] | null = null): MockPane {
  const { tmux, ...rest } = extra;
  return {
    info: {
      key,
      host,
      kind: tmux === null ? "direct" : "tmux",
      tmux:
        tmux === null
          ? null
          : {
              paneId: `%${key}`,
              windowId: `@${key}`,
              sessionId: `$${key}`,
              sessionName: "main",
              sessionGroup: null,
              windowIndex: 1,
              windowName: "bash",
              paneIndex: 1,
              dead: false,
              windowActive: true,
              paneActive: true,
              windowPanes: 1,
              sized: false,
              ...tmux,
            },
      width: 100,
      height: 28,
      currentCommand: "bash",
      currentPath: "/home/consulear",
      title: "",
      harness: "shell",
      alternateOn: false,
      chmId: null,
      hidden: false,
      labels: [],
      ended: null,
      bell: null,
      bellPings: rest.currentCommand === "irssi",
      ...rest,
    },
    lines,
    cursor,
  };
}

const peers: TailnetPeer[] = [
  { id: "spark-d683", hostName: "spark-d683", dnsName: "spark-d683.tail35393d.ts.net", os: "linux", ips: ["100.107.0.84"], online: true, sshHostKeys: ["ssh-ed25519 AAAA"], isSelf: false },
  { id: "spark2", hostName: "spark2", dnsName: "spark2.tail35393d.ts.net", os: "linux", ips: ["100.125.245.126"], online: true, sshHostKeys: ["ssh-ed25519 AAAA"], isSelf: false },
  { id: "iphone-se-gen-2", hostName: "localhost", dnsName: "iphone-se-gen-2.tail35393d.ts.net", os: "iOS", ips: ["100.89.219.104"], online: true, sshHostKeys: [], isSelf: false },
  { id: "mbas-macbook-pro", hostName: "MBA’s MacBook Pro", dnsName: "mbas-macbook-pro.tail35393d.ts.net", os: "macOS", ips: ["100.72.82.18"], online: false, sshHostKeys: [], isSelf: false },
];

function toAnsi(lines: Seg[][]): string {
  const sgr = (fg: number, attrs: number) => {
    const codes = ["0"];
    if (attrs & 1) codes.push("1");
    if (fg >>> 24 === 1) codes.push(`38;5;${fg & 0xff}`);
    return `\x1b[${codes.join(";")}m`;
  };
  return lines.map((segs) => segs.map(([t, fg = 0, a = 0]) => sgr(fg, a) + t).join("") + "\x1b[0m").join("\r\n");
}

export function mockBackend(): Backend {
  const streaming = new Set<number>();
  const listeners = new Set<(ev: CoreEvent) => void>();
  const emit = (ev: CoreEvent) => listeners.forEach((l) => l(ev));
  let frameCb: ((b: Uint8Array) => void) | null = null;

  const config: { hosts: HostConfig[]; labels: LabelDef[] } = {
    labels: [
      { id: "terrarium", name: "terrarium", color: "#4ade9a" },
      { id: "urgent", name: "urgent", color: "#ff6b81" },
    ],
    hosts: [
      { id: "spark-d683", address: null, port: 22, user: "consulear", auth: { kind: "auto" }, autoConnect: true },
      { id: "spark2", address: null, port: 22, user: "consulear", auth: { kind: "auto" }, autoConnect: true },
    ],
  };
  const hosts: HostState[] = [
    { id: "spark-d683", phase: { phase: "connected" }, facts: { user: "consulear", home: "/home/consulear", shell: "/bin/bash", uname: "Linux 6.11", tmuxVersion: "3.4" } },
    { id: "spark2", phase: { phase: "awaitingTailscaleCheck", url: "https://login.tailscale.com/a/example" }, facts: null },
    { id: "@local", phase: { phase: "connected" }, facts: { user: "consul", home: "C:/Users/consul", shell: "C:/Program Files/PowerShell/7/pwsh.exe", uname: "windows DESKTOP-CONSUL", tmuxVersion: null } },
  ];
  const panes: MockPane[] = [
    pane(1, "spark-d683", { tmux: { sessionName: "annotator-omp-1", sessionGroup: "annotator-omp", windowName: "omp" }, currentCommand: "omp", harness: "omp", labels: ["terrarium"], title: "π > Hysteresis benchmark control arm run", currentPath: "/home/consulear/Programming/terrarium-annotator", width: 120, height: 29 }, ompLines),
    pane(2, "spark-d683", { tmux: { sessionName: "consuls", windowName: "claude" }, currentCommand: "claude", harness: "claude", title: "✳ Refactor supervisor", currentPath: "/home/consulear/code/consuls", width: 68, height: 22 }, claudeLines, [4, 15]),
    pane(3, "spark-d683", { tmux: { sessionName: "fix-owui-3", windowName: "codex" }, currentCommand: "codex", harness: "codex", labels: ["urgent"], title: "", currentPath: "/home/consulear/Programming/open-webui", width: 66, height: 18 }, codexLines, [4, 13]),
    pane(4, "spark-d683", { tmux: { sessionName: "dual-setup-2", windowName: "bash" }, currentPath: "/home/consulear/models" }, shellLines, [21, 3]),
    pane(5, "spark-d683", { tmux: null, currentPath: "/home/consulear", chmId: "d5" }, shellLines, [21, 3]),
    pane(6, "spark-d683", { tmux: null, currentPath: "/home/consulear/irc", currentCommand: "bash", chmId: "d6", ended: "Connection lost" }, shellLines),
    pane(7, "@local", { tmux: null, currentPath: "C:/Users/consul/code", currentCommand: "PowerShell", chmId: "d7" }, shellLines, [21, 3]),
  ];

  const sendTiles = () => {
    if (!frameCb) return;
    for (const p of panes) {
      const snap = screen(p.info.width, p.info.height, p.lines, p.cursor);
      frameCb(encodeFrame(FRAME_TILE, p.info.key, encodeTile(snap)));
    }
  };

  // Keep one pane "working".
  let tick = 0;
  setInterval(() => {
    tick++;
    const p = panes[2];
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[tick % 10];
    p.lines = [...codexLines.slice(0, -4), [[`${spinner} `, P(6)], [`Working (${tick}s • esc to interrupt)`, P(8)]], [], ...codexLines.slice(-2)];
    if (frameCb) frameCb(encodeFrame(FRAME_TILE, p.info.key, encodeTile(screen(p.info.width, p.info.height, p.lines, p.cursor))));
  }, 1000);

  const snapshot = (): CoreSnapshot => ({
    tailnet: { backendState: "Running", authUrl: null, selfNode: null, peers, tailnetName: "consulear@example.com", health: [], error: null },
    config: { hosts: [...config.hosts], labels: [...config.labels], sound: mockSound },
    hosts: [...hosts],
    panes: panes.filter((p) => hosts.find((h) => h.id === p.info.host)?.phase.phase === "connected").map((p) => p.info),
    attention: [...attention.values()],
  });

  const emitConfig = () => emit({ type: "config", config: { hosts: [...config.hosts], labels: [...config.labels], sound: mockSound } });
  const emitPanes = (host: string) => emit({ type: "panes", host, panes: panes.filter((p) => p.info.host === host).map((p) => p.info) });

  let mockIntegration: Omit<IntegrationStatus, "notes"> = { claude: "notInstalled", codex: "absent", omp: "notInstalled" };
  let mockSound: SoundPrefs = { enabled: true, volume: 0.7, finished: true, needsInput: true, subtask: true, bell: true, toasts: true };
  const attention = new Map<number, PaneAttention>();
  let mockFocus: FocusState = { expanded: null, windowFocused: true };
  const setAttention = (st: PaneAttention) => {
    attention.set(st.key, st);
    emit({ type: "attention", state: st });
  };
  const signal = (key: number, activity: PaneAttention["activity"], reason: string) => {
    const prev = attention.get(key);
    const waiting = activity === "idle" || activity === "needsInput";
    setAttention({
      key,
      activity,
      attention: waiting ? (mockFocus.expanded === key ? "acked" : "unacked") : "none",
      reason,
      since: Date.now() / 1000,
      pulse: prev?.pulse ?? 0,
      source: "hook",
    });
  };
  // A little story: the codex pane finishes, the claude pane asks for permission.
  setTimeout(() => signal(1, "working", "Working"), 300);
  setTimeout(() => signal(3, "working", "Working"), 300);
  setTimeout(() => signal(2, "working", "Working"), 300);
  setTimeout(() => signal(3, "idle", "Finished — your turn"), 3500);
  setTimeout(() => signal(2, "needsInput", "Needs permission: Bash"), 6000);

  const setPhase = (id: string, phase: HostState["phase"]) => {
    const h = hosts.find((h) => h.id === id);
    if (!h) return;
    h.phase = phase;
    emit({ type: "host", state: { ...h } });
  };

  return {
    kind: "mock",
    getSnapshot: async () => snapshot(),
    onEvent: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onAlert: async () => () => {},
    onFocusPane: async () => () => {},
    setFocus: async (focus) => {
      mockFocus = focus;
      const st = attention.get(focus.expanded ?? -1);
      if (st && st.attention === "unacked") setAttention({ ...st, attention: "acked" });
    },
    ackPane: async (key) => {
      const st = attention.get(key);
      if (st && st.attention === "unacked") setAttention({ ...st, attention: "acked" });
    },
    setPaneMuted: async () => {},
    setSoundPrefs: async (prefs) => {
      mockSound = prefs;
      emit({ type: "config", config: { hosts: [...config.hosts], labels: [...config.labels], sound: mockSound } });
    },
    testChime: async () => {},
    setWindowTitle: async (title) => {
      document.title = title;
    },
    subscribeFrames: async (cb) => {
      frameCb = cb;
      setTimeout(sendTiles, 50);
    },
    upsertHost: async (cfg) => {
      const i = config.hosts.findIndex((h) => h.id === cfg.id);
      if (i >= 0) config.hosts[i] = cfg;
      else config.hosts.push(cfg);
      if (!hosts.find((h) => h.id === cfg.id)) hosts.push({ id: cfg.id, phase: { phase: "connecting" }, facts: null });
      emit({ type: "config", config: { hosts: [...config.hosts], labels: [...config.labels], sound: mockSound } });
      emit({ type: "host", state: { ...hosts.find((h) => h.id === cfg.id)! } });
      setTimeout(() => setPhase(cfg.id, { phase: "connected" }), 1200);
    },
    removeHost: async (id) => {
      config.hosts = config.hosts.filter((h) => h.id !== id);
      emit({ type: "config", config: { hosts: [...config.hosts], labels: [...config.labels], sound: mockSound } });
      emit({ type: "hostRemoved", id });
    },
    connectHost: async (id) => {
      setPhase(id, { phase: "connecting" });
      setTimeout(() => setPhase(id, { phase: "connected" }), 900);
    },
    reconnectHost: async (id) => {
      setPhase(id, { phase: "reconnecting", attempt: 1, retryInMs: 1000, lastError: "reconnect requested" });
      setTimeout(() => setPhase(id, { phase: "connected" }), 1200);
    },
    disconnectHost: async (id) => {
      setPhase(id, { phase: "disconnected" });
      emit({ type: "panes", host: id, panes: [] });
    },
    forgetHostKey: async () => {},
    refreshTailnet: async () => snapshot().tailnet,
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener");
      if (url.includes("tailscale.com")) setTimeout(() => setPhase("spark2", { phase: "connected" }), 1500);
    },
    setVisiblePanes: async () => {},
    streamPane: async (key, on) => {
      const p = panes.find((p) => p.info.key === key);
      if (!p || !on || !frameCb) return;
      streaming.add(key);
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint16(0, p.info.width, true);
      new DataView(header.buffer).setUint16(2, p.info.height, true);
      const body = new TextEncoder().encode(toAnsi(p.lines));
      const payload = new Uint8Array(4 + body.length);
      payload.set(header);
      payload.set(body, 4);
      frameCb(encodeFrame(FRAME_RESET, key, payload));
    },
    sendKeys: async (key, keys) => {
      const echo = keys.map((k) => (k === "Enter" ? "\r\n" : k === "BSpace" ? "\b \b" : k === "C-j" ? "\r\n  " : "")).join("");
      if (echo && frameCb && streaming.has(key)) frameCb(encodeFrame(FRAME_RAW, key, new TextEncoder().encode(echo)));
    },
    sendText: async (key, text) => {
      if (frameCb && streaming.has(key)) frameCb(encodeFrame(FRAME_RAW, key, new TextEncoder().encode(text)));
    },
    submitPrompt: async (key, text) => {
      if (frameCb && streaming.has(key)) frameCb(encodeFrame(FRAME_RAW, key, new TextEncoder().encode(text.replace(/\n/g, "\r\n") + "\r\n")));
    },
    createPane: async (spec) => {
      const key = 100 + panes.length;
      const name = spec.cwd.split("/").filter(Boolean).pop() ?? "agent";
      panes.push(
        pane(
          key,
          spec.host,
          {
            tmux: spec.direct ? null : { sessionName: `${name}-${spec.harness}`, windowName: spec.harness },
            currentCommand: spec.harness === "shell" ? "bash" : spec.harness,
            harness: spec.harness,
            currentPath: spec.cwd,
            chmId: `mock${key}`,
          },
          [[["Starting " + spec.harness + "…", P(8)]]],
          [0, 1],
        ),
      );
      emitPanes(spec.host);
      setTimeout(sendTiles, 50);
      return key;
    },
    resizePane: async (key, cols, rows) => {
      const p = panes.find((p) => p.info.key === key);
      if (!p) throw new Error("no such pane");
      p.info = { ...p.info, width: cols, height: rows, tmux: p.info.tmux && { ...p.info.tmux, sized: true }, chmId: p.info.chmId ?? `mock${key}` };
      emitPanes(p.info.host);
      if (streaming.has(key)) {
        const header = new Uint8Array(4);
        new DataView(header.buffer).setUint16(0, cols, true);
        new DataView(header.buffer).setUint16(2, rows, true);
        const body = new TextEncoder().encode(toAnsi(p.lines));
        const payload = new Uint8Array(4 + body.length);
        payload.set(header);
        payload.set(body, 4);
        frameCb?.(encodeFrame(FRAME_RESET, key, payload));
      }
      return { otherClients: key === 1 ? 1 : 0 };
    },
    releasePaneSize: async (key) => {
      const p = panes.find((p) => p.info.key === key);
      if (!p) return;
      p.info = { ...p.info, tmux: p.info.tmux && { ...p.info.tmux, sized: false } };
      emitPanes(p.info.host);
    },
    createLabel: async (name, color) => {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "label";
      let id = base;
      for (let n = 2; config.labels.some((l) => l.id === id); n++) id = `${base}-${n}`;
      const label = { id, name, color };
      config.labels = [...config.labels, label];
      emitConfig();
      return label;
    },
    updateLabel: async (label) => {
      config.labels = config.labels.map((l) => (l.id === label.id ? label : l));
      emitConfig();
    },
    deleteLabel: async (id) => {
      config.labels = config.labels.filter((l) => l.id !== id);
      emitConfig();
      for (const p of panes) if (p.info.labels.includes(id)) p.info = { ...p.info, labels: p.info.labels.filter((l) => l !== id) };
      new Set(panes.map((p) => p.info.host)).forEach(emitPanes);
    },
    setPaneBell: async (key, bell) => {
      const p = panes.find((p) => p.info.key === key);
      if (!p) return;
      p.info = { ...p.info, bell, bellPings: bell ?? p.info.currentCommand === "irssi" };
      emitPanes(p.info.host);
    },
    setPaneLabels: async (key, labels) => {
      const p = panes.find((p) => p.info.key === key);
      if (!p) return;
      p.info = { ...p.info, labels };
      emitPanes(p.info.host);
    },
    setPaneHidden: async (key, hidden) => {
      const p = panes.find((p) => p.info.key === key);
      if (!p) return;
      p.info = { ...p.info, hidden };
      emitPanes(p.info.host);
    },
    terminatePane: async (key) => {
      await new Promise((r) => setTimeout(r, 900));
      const i = panes.findIndex((p) => p.info.key === key);
      if (i >= 0) {
        const host = panes[i].info.host;
        panes.splice(i, 1);
        emitPanes(host);
      }
      return { kind: "closed" };
    },
    integrationStatus: async () => ({ ...mockIntegration, notes: [] }),
    installIntegration: async () => {
      await new Promise((r) => setTimeout(r, 700));
      mockIntegration = { claude: "installed", codex: "installed", omp: "installed" };
      return { ...mockIntegration, notes: ["Backed up Claude settings to ~/.claude/settings.json.chm-bak-1790000000", "Claude Code: hooks added. Sessions already running pick them up after a restart."] };
    },
    uninstallIntegration: async () => {
      mockIntegration = { claude: "notInstalled", codex: "notInstalled", omp: "notInstalled" };
      return { ...mockIntegration, notes: ["Claude Code: hooks removed."] };
    },
    listDir: async (host, path) => mockListDir(host, path),
    fsOp: async (host, op) => mockFsOp(host, op),
    fsCount: async (host, path) => mockFsCount(host, path),
    gitStatus: async (host, dir) => mockGitStatus(host, dir),
    sendInput: async (key, data) => {
      if (frameCb && streaming.has(key)) frameCb(encodeFrame(FRAME_RAW, key, new TextEncoder().encode(data === "\r" ? "\r\n" : data)));
    },
    onConfirmQuit: async () => () => {},
    quitApp: async () => {},
    localShells: async () => [
      { id: "pwsh", name: "PowerShell", path: "C:/Program Files/PowerShell/7/pwsh.exe" },
      { id: "git-bash", name: "Git Bash", path: "C:/Program Files/Git/bin/bash.exe" },
      { id: "cmd", name: "Command Prompt", path: "C:/WINDOWS/system32/cmd.exe" },
    ],
    pasteText: async (key, text) => {
      if (frameCb && streaming.has(key)) frameCb(encodeFrame(FRAME_RAW, key, new TextEncoder().encode(text.replace(/\n/g, "\r\n"))));
    },
  };
}
