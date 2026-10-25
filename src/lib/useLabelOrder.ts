import { useState } from "react";

import { backend } from "../ipc/backend";
import type { LabelDef } from "../ipc/bindings/LabelDef";
import { useApp } from "../store/app";
import { inOrder } from "./labels";

/** The labels in order, and a way to reorder them: a new order shows at once, until the core's
 * Config event (with the order shared to every device) replaces the labels. */
export function useLabelOrder(): [LabelDef[], (ids: string[]) => void] {
  const defs = useApp((s) => s.config.labels);
  const [pending, setPending] = useState<{ base: LabelDef[]; ids: string[] } | null>(null);
  const labels = pending?.base === defs ? inOrder(defs, pending.ids) : defs;
  const reorder = (ids: string[]) => {
    setPending({ base: defs, ids });
    void backend().then((b) => b.reorderLabels(ids));
  };
  return [labels, reorder];
}
