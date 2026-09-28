import { Loader2, Power } from "lucide-react";
import { useState } from "react";

import { backend } from "../ipc/backend";
import { useApp } from "../store/app";
import { harnessLabel, isAgent } from "./HarnessBadge";
import Modal, { Button } from "./Modal";
import { displayTitle } from "./MiniTile";
import { isDirect, paneWhere } from "../lib/panes";

export default function TerminateDialog({ paneKey }: { paneKey: number }) {
  const close = () => useApp.getState().setTerminating(null);
  const pane = useApp((s) => Object.values(s.panes).flat().find((p) => p.key === paneKey));
  const [state, setState] = useState<"confirm" | "working" | "stuck">("confirm");
  const [stuckOn, setStuckOn] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!pane) return null;
  const agent = isAgent(pane.harness);
  const direct = isDirect(pane);

  const run = async (force: boolean) => {
    setState("working");
    setError(null);
    try {
      const outcome = await (await backend()).terminatePane(paneKey, force);
      if (outcome.kind === "closed") {
        if (useApp.getState().expanded === paneKey) useApp.getState().setExpanded(null);
        close();
      } else {
        setStuckOn(outcome.command);
        setState("stuck");
      }
    } catch (e) {
      setError(String(e));
      setState("confirm");
    }
  };

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Power className="h-4 w-4 text-rose-400" /> Close “{displayTitle(pane)}”
        </span>
      }
      onClose={close}
      width={460}
      footer={
        state === "stuck" ? (
          <>
            <Button onClick={close}>Leave it running</Button>
            <Button kind="danger" onClick={() => run(true)}>
              Force kill
            </Button>
          </>
        ) : (
          <>
            {error && <span className="mr-auto truncate text-[12px] text-rose-400">{error}</span>}
            <Button onClick={close} disabled={state === "working"}>
              Cancel
            </Button>
            <Button kind="danger" onClick={() => run(false)} disabled={state === "working"}>
              {state === "working" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {direct ? "Close shell" : agent ? `Quit ${harnessLabel(pane.harness)} & close` : "Close pane"}
            </Button>
          </>
        )
      }
    >
      {direct ? (
        <p className="text-[13px] leading-relaxed text-mist-300">
          This hangs up the plain shell on {pane.host}; anything still running in it gets the hang-up signal and exits. Plain shells
          can't be reattached later.
        </p>
      ) : state === "stuck" ? (
        <p className="text-[13px] leading-relaxed text-mist-300">
          <span className="font-mono text-mist-100">{stuckOn || "The process"}</span> is still running in this pane. Force-killing closes the
          tmux pane immediately; anything unsaved in it is lost.
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-mist-300">
          {agent ? (
            <>
              Consuls will ask {harnessLabel(pane.harness)} to exit (so it can save its session), then close the tmux pane{" "}
              <span className="font-mono text-mist-100">
                {paneWhere(pane, true)}
              </span>{" "}
              on {pane.host}.
            </>
          ) : (
            <>
              This closes the tmux pane{" "}
              <span className="font-mono text-mist-100">
                {paneWhere(pane, true)}
              </span>{" "}
              on {pane.host}.
            </>
          )}
          <span className="mt-2 block text-[12px] text-mist-500">To just remove it from the dashboard and keep it running, use Hide instead.</span>
        </p>
      )}
    </Modal>
  );
}
