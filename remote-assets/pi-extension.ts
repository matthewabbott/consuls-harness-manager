// Consuls: records pi lifecycle events for the Consuls dashboard (no-op outside panes
// Consuls knows: tmux panes, or plain shells it started, which export CHM_PANE).
// Loaded per session with `pi -e <this file>`; it only shells out to chm-hook.sh.
import { spawn } from "node:child_process";

const SH = "__SH__";
const HOOK = "__HOOK__";

function record(event: string, detail = "", sessionId = "") {
  if (!process.env.TMUX_PANE && !process.env.CHM_PANE) return;
  try {
    const payload = JSON.stringify({ session_id: sessionId, notification_type: detail });
    const child = spawn(SH, [HOOK, "pi", event, payload], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Never let the dashboard integration disturb the agent.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

function session(ctx: Ctx): string {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

function idle(ctx: Ctx): boolean {
  try {
    return ctx?.isIdle?.() ?? true;
  } catch {
    return true;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function consuls(pi: any) {
  // pi ≥ 0.80 reports when a run has fully settled (no retry, compaction or queued message
  // left); older ones only end each run, so the first settle switches that fallback off.
  let settles = false;
  pi.on("session_start", (_e: unknown, ctx: Ctx) => record("SessionStart", "", session(ctx)));
  pi.on("agent_start", (_e: unknown, ctx: Ctx) => record("UserPromptSubmit", "", session(ctx)));
  pi.on("agent_settled", (e: { aborted?: boolean }, ctx: Ctx) => {
    settles = true;
    record(e?.aborted ? "Interrupted" : "Stop", "", session(ctx));
  });
  pi.on("agent_end", (_e: unknown, ctx: Ctx) => {
    setTimeout(() => {
      if (!settles && idle(ctx)) record("Stop", "", session(ctx));
    }, 500);
  });
  // An extension waiting on you mid-run (a confirmation, a choice).
  pi.on("ui_prompt_start", (_e: unknown, ctx: Ctx) => {
    if (!idle(ctx)) record("Notification", "agent_needs_input", session(ctx));
  });
  pi.on("ui_prompt_end", (_e: unknown, ctx: Ctx) => {
    if (!idle(ctx)) record("UserPromptSubmit", "", session(ctx));
  });
  pi.on("session_shutdown", (e: { reason?: string }, ctx: Ctx) => {
    // Other reasons (new, resume, fork, reload) start a session straight after.
    if (!e?.reason || e.reason === "quit") record("SessionEnd", "", session(ctx));
  });
}
