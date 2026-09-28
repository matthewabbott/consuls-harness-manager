// "Show in File Explorer" / "Open in VS Code": which of them apply to a path, and running them.

import { useEffect, useState } from "react";

import { backend, type VsCodeStatus } from "../ipc/backend";
import { useApp } from "../store/app";
import { isLocal } from "./hosts";

const platform = typeof navigator === "undefined" ? "" : navigator.userAgent;

/** The file manager's name on this OS. */
export const REVEAL_LABEL = /Mac/.test(platform) ? "Reveal in Finder" : /Windows/.test(platform) ? "Show in File Explorer" : "Show in file manager";

let status: Promise<VsCodeStatus> | null = null;

function fetchStatus(): Promise<VsCodeStatus> {
  status = backend()
    .then((b) => b.vscodeStatus())
    .catch(() => ({ installed: false, remoteSsh: false }));
  return status;
}

/** Whether VS Code (and Remote-SSH) is installed; re-checked when the window regains focus. */
export function useVsCode(): VsCodeStatus {
  const [s, setS] = useState<VsCodeStatus>({ installed: false, remoteSsh: false });
  useEffect(() => {
    let live = true;
    void (status ?? fetchStatus()).then((v) => live && setS(v));
    const onFocus = () => void fetchStatus().then((v) => live && setS(v));
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return s;
}

/** Whether "Open in VS Code" makes sense for a path on `host`. */
export function canOpenInVsCode(vs: VsCodeStatus, host: string): boolean {
  return vs.installed && (isLocal(host) || vs.remoteSsh);
}

const report = (e: unknown) => useApp.getState().notify("error", String(e));

export function revealPath(host: string, path: string) {
  void backend()
    .then((b) => b.revealPath(host, path))
    .catch(report);
}

export function openInVsCode(host: string, path: string, line?: number, col?: number) {
  void backend()
    .then((b) => b.openInVscode(host, path, line, col))
    .catch(report);
}
