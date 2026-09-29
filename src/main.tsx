import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { loadUiState } from "./lib/uiState";
import { useUi } from "./store/ui";
import { useViewPrefs } from "./store/viewPrefs";
import "./styles.css";

// Layout and zoom come from the core; load them before the first paint.
void loadUiState().finally(async () => {
  await useUi.persist.rehydrate();
  await useViewPrefs.persist.rehydrate();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
