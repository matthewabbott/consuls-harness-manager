// The app's other windows (desktop): what each one's layout shows, for hotkeys that jump to
// something shown elsewhere, and so a pane shown in two windows isn't resized by both.

import { create } from "zustand";

import { backend } from "../ipc/backend";

export interface ShownIn {
  label: string;
  targets: string[];
  /** This window. */
  mine: boolean;
}

export const useWindows = create<{ views: ShownIn[] }>(() => ({ views: [] }));

export async function followWindows() {
  const b = await backend();
  await b.onWindowViews((views) => useWindows.setState({ views: views.map((v) => ({ ...v, mine: v.label === b.windowLabel })) }));
}
