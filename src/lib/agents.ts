// What the phone UIs (the Home Screen web app and the iPhone app) say about agents and machines.

import type { Harness } from "../ipc/bindings/Harness";
import type { HostPhase } from "../ipc/bindings/HostPhase";
import type { PaneAttention } from "../ipc/bindings/PaneAttention";
import type { PaneInfo } from "../ipc/bindings/PaneInfo";

export const HARNESS_DOT: Record<Harness, string> = {
  claude: "bg-claude",
  codex: "bg-codex",
  omp: "bg-omp",
  pi: "bg-pi",
  opencode: "bg-opencode",
  gemini: "bg-gemini",
  shell: "bg-mist-500",
};

export const HARNESS_NAME: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  omp: "omp",
  pi: "pi",
  opencode: "opencode",
  gemini: "Gemini",
  shell: "shell",
};

/** Agents (and anything already tracked): the panes worth a switch. */
export const trackable = (p: PaneInfo) => p.kind === "tmux" && (p.notify !== null || (p.harness !== null && p.harness !== "shell"));

export function status(att: PaneAttention | undefined): { text: string; tone: string } {
  if (!att) return { text: "", tone: "text-mist-400" };
  switch (att.activity) {
    case "working":
      return { text: "working", tone: "text-sky-400" };
    case "needsInput":
      return { text: att.reason ?? "needs you", tone: "text-iris-300" };
    case "idle":
      return att.attention === "none" ? { text: "idle", tone: "text-mist-400" } : { text: "waiting on you", tone: "text-ember-300" };
    default:
      return { text: "", tone: "text-mist-400" };
  }
}

export function phaseText(phase: HostPhase | undefined): { text: string; tone: string } | null {
  if (!phase) return null;
  switch (phase.phase) {
    case "connected":
      return null;
    case "awaitingTailscaleCheck":
      return { text: "waiting for Tailscale SSH approval", tone: "text-iris-300" };
    case "failed":
      return { text: `failed: ${phase.error}`, tone: "text-rose-400" };
    case "reconnecting":
      return { text: "reconnecting…", tone: "text-ember-300" };
    default:
      return { text: phase.phase, tone: "text-mist-400" };
  }
}
