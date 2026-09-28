// Consuls: records omp lifecycle events for the Consuls dashboard (no-op outside tmux).
// Loaded per session with `omp --hook <this file>`; it only shells out to chm-hook.sh.
import { spawn } from "node:child_process";

const HOOK = "__HOOK__";

function record(event: string, detail = "", sessionId = "") {
  if (!process.env.TMUX_PANE) return;
  try {
    const payload = JSON.stringify({ session_id: sessionId, notification_type: detail });
    const child = spawn("sh", [HOOK, "omp", event, payload], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Never let the dashboard integration disturb the agent.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function consuls(pi: any) {
  pi.on("session_start", () => record("SessionStart"));
  pi.on("input", () => record("UserPromptSubmit"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", (e: any) => {
    if (!e?.willContinue) record("Stop");
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_approval_requested", (e: any) => record("PermissionRequest", e?.toolName ?? "", e?.sessionId ?? ""));
  pi.on("session_shutdown", () => record("SessionEnd"));
}
