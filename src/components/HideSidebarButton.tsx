import { PanelLeftClose } from "lucide-react";

import { useUi } from "../store/ui";

/** The collapse button in the top-right corner of a left sidebar panel. */
export default function HideSidebarButton() {
  return (
    <button
      onClick={() => useUi.getState().toggleSidebar()}
      title="Hide sidebar (Ctrl+Shift+B)"
      className="rounded-md p-1 text-mist-500 transition-colors hover:bg-ink-700 hover:text-mist-200"
    >
      <PanelLeftClose className="h-3.5 w-3.5" />
    </button>
  );
}
