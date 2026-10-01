import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { inWebApp } from "../ipc/backend";
import { loadUiState } from "../lib/uiState";
import { useUi } from "../store/ui";
import { useViewPrefs } from "../store/viewPrefs";
import App from "./App";
import "./mobile.css";

const root = createRoot(document.getElementById("root")!);

if (inWebApp) {
  // The Home Screen app: the service worker (offline page, notifications), no page zoom, and the
  // app once the server answers (WebGate).
  void navigator.serviceWorker?.register("/sw.js", { scope: "/" }).catch(() => {});
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  void import("./WebGate").then(({ default: WebGate }) =>
    root.render(
      <StrictMode>
        <WebGate />
      </StrictMode>,
    ),
  );
} else {
  // Drafts, history and text sizes come from the core; load them before the first paint.
  void loadUiState().finally(async () => {
    await useUi.persist.rehydrate();
    await useViewPrefs.persist.rehydrate();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}
