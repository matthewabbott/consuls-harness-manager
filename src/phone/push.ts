// Web Push on the phone: the service worker, and this device's subscription with the daemon.
// On iOS it only works from the Home Screen app, and asking needs a tap.

import { api } from "./api";

export type PushStatus = "unsupported" | "needs-install" | "denied" | "off" | "on";

export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Running as the Home Screen app (not a Safari tab). */
export const standalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function register(): Promise<void> {
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function current(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

export async function status(): Promise<{ status: PushStatus; endpoint: string | null }> {
  if (!supported()) return { status: isIOS && !standalone() ? "needs-install" : "unsupported", endpoint: null };
  if (Notification.permission === "denied") return { status: "denied", endpoint: null };
  const sub = await current();
  return sub && Notification.permission === "granted" ? { status: "on", endpoint: sub.endpoint } : { status: "off", endpoint: null };
}

/** Asks for notifications and subscribes (call from a tap). Returns the endpoint. */
export async function enable(vapidKey: string): Promise<string> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for Consuls in Settings" : "Notifications weren't allowed");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !keyMatches(sub, vapidKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(vapidKey) });
  await tell(sub);
  return sub.endpoint;
}

export async function disable(): Promise<void> {
  const sub = await current();
  if (!sub) return;
  await api.unsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** Tells the daemon about this device again (every launch: Safari doesn't reliably say when a
 * subscription changes), subscribing afresh if the daemon's key changed. */
export async function resync(vapidKey: string): Promise<void> {
  let sub = await current();
  if (!sub || Notification.permission !== "granted") return;
  if (!keyMatches(sub, vapidKey)) {
    await sub.unsubscribe();
    const reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(vapidKey) });
  }
  await tell(sub);
}

async function tell(sub: PushSubscription) {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("the browser gave an incomplete subscription");
  await api.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, label: isIOS ? "iPhone" : navigator.platform || "browser" });
}

function keyMatches(sub: PushSubscription, vapidKey: string): boolean {
  const key = sub.options.applicationServerKey;
  return !key || toB64(new Uint8Array(key)) === vapidKey.replace(/=+$/, "");
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
