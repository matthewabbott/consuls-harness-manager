import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { loadUiState } from "../lib/uiState";
import { useUi } from "../store/ui";
import { useViewPrefs } from "../store/viewPrefs";
import App from "./App";
import "./mobile.css";

// Drafts, history and text sizes come from the core; load them before the first paint.
void loadUiState().finally(async () => {
  await useUi.persist.rehydrate();
  await useViewPrefs.persist.rehydrate();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
