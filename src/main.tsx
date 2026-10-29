import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { backend } from "./ipc/backend";
import { loadUiState } from "./lib/uiState";
import { useAlertsSeen } from "./store/alerts";
import { useHotkeys } from "./store/hotkeys";
import { startLayout } from "./store/layout";
import { useUi } from "./store/ui";
import { useViewPrefs } from "./store/viewPrefs";
import { followWindows } from "./store/windows";
import "./styles.css";

// Layout and zoom come from the core; load them before the first paint.
void loadUiState().finally(async () => {
  await useUi.persist.rehydrate();
  await useViewPrefs.persist.rehydrate();
  await useHotkeys.persist.rehydrate();
  await useAlertsSeen.persist.rehydrate();
  const b = await backend();
  await startLayout(b.windowLabel);
  void followWindows();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
