// This PC's drives, for the folder browsers' drive buttons and menu.

import { useEffect, useState } from "react";

import { backend } from "../ipc/backend";
import type { DriveInfo } from "../ipc/bindings/DriveInfo";
import { LOCAL_HOST } from "./hosts";

let cache: Promise<DriveInfo[]> | null = null;

/** The drives of `host` (only This PC has any), asked for once; null until known. */
export function useDrives(host: string): DriveInfo[] | null {
  const [drives, setDrives] = useState<DriveInfo[] | null>(null);
  useEffect(() => {
    if (host !== LOCAL_HOST) return;
    cache ??= backend()
      .then((b) => b.localDrives())
      .catch(() => []);
    let live = true;
    void cache.then((d) => live && setDrives(d));
    return () => {
      live = false;
    };
  }, [host]);
  return host === LOCAL_HOST ? drives : [];
}

const KIND: Record<DriveInfo["kind"], string> = {
  fixed: "Local disk",
  removable: "Removable drive",
  network: "Network drive",
  optical: "CD/DVD drive",
  ram: "RAM disk",
  unknown: "Drive",
};

/** "New Volume" or "Local disk" etc. */
export function driveName(d: DriveInfo): string {
  return d.volume ?? KIND[d.kind];
}
