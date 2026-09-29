// The push daemon's API (crates/chm-daemon/src/http.rs), same origin.

import type { DaemonState } from "../ipc/bindings/DaemonState";
import type { NotifyMode } from "../ipc/bindings/NotifyMode";
import type { Subscription } from "../ipc/bindings/Subscription";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const post = (path: string, body: unknown = {}) => call<void>(path, { method: "POST", body: JSON.stringify(body) });

export type NewSubscription = Pick<Subscription, "endpoint" | "keys" | "label">;

export const api = {
  state: () => call<DaemonState>("/api/state"),
  setNotify: (key: number, mode: NotifyMode | null) => post(`/api/panes/${key}/notify`, { mode }),
  seen: (key: number) => post(`/api/panes/${key}/seen`),
  subscribe: (sub: NewSubscription) => post("/api/push/subscribe", sub),
  unsubscribe: (endpoint: string) => post("/api/push/unsubscribe", { endpoint }),
  test: (endpoint: string) => post("/api/push/test", { endpoint }),
};
