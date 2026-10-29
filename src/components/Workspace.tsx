import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { backend } from "../ipc/backend";
import { fileTarget, leaves, paneTarget } from "../lib/layoutTree";
import { displayTitle, paneIdentity } from "../lib/panes";
import { sortPanes } from "../lib/organize";
import { keyLabel } from "../lib/platform";
import { useApp } from "../store/app";
import { useAttachmentsOf } from "../store/attachments";
import { useEditor } from "../store/editor";
import { composerTarget, useLayout } from "../store/layout";
import { useRedact } from "../store/recording";
import { COMPOSER, FILMSTRIP, useUi } from "../store/ui";
import Composer, { type ComposerHandle } from "./Composer";
import FileTile from "./FileTile";
import { isAgent } from "./HarnessBadge";
import LayoutView from "./LayoutView";
import MiniTile from "./MiniTile";
import { HeaderIcon } from "./PaneLeaf";
import QuickKeys from "./QuickKeys";
import ResizeHandle from "./ResizeHandle";

/**
 * The window when it isn't showing the grid: its splits, the composer for the focused pane (one
 * composer, whichever pane it types into), and a strip of everything else.
 */
export default function Workspace() {
  const panes = useApp((s) => s.panes);
  const hosts = useApp((s) => s.hosts);
  const files = useEditor((s) => s.files);
  const order = useEditor((s) => s.order);
  const layout = useLayout();
  const filmstripWidth = useUi((s) => s.filmstripWidth);
  const filmstripCollapsed = useUi((s) => s.filmstripCollapsed);
  const maximized = useUi((s) => s.maximized);
  const composerHeight = useUi((s) => s.composerHeight);
  const composerRef = useRef<ComposerHandle>(null);
  const r = useRedact();
  const ui = useUi.getState;
  const list = useMemo(() => Object.values(panes).flat(), [panes]);
  const target = composerTarget(layout, list);
  const attachments = useAttachmentsOf(target ? paneIdentity(target) : "");
  const all = leaves(layout.root);
  const split = all.length > 1;
  const shown = new Set(all.map((l) => l.target));
  const ended = target?.ended != null;

  const lastOpened = useUi((s) => s.lastOpened);
  const attention = useApp((s) => s.attention);
  // The ones you looked at last first (never opened: by name), then open files, latest first.
  const others = sortPanes(
    list.filter((p) => !p.hidden && !shown.has(paneTarget(paneIdentity(p)))),
    "recent",
    displayTitle,
    attention,
    lastOpened,
    paneIdentity,
  );
  const otherFiles = order.filter((id) => files[id] && !shown.has(fileTarget(id))).reverse();
  const count = others.length + otherFiles.length;
  const waitingElsewhere = useApp((s) => others.filter((p) => s.attention[p.key]?.attention === "unacked").length);
  const showFilmstrip = count > 0 && !filmstripCollapsed && !maximized;

  // Focus moved to an agent's split (a hotkey, a jump, a click on its tile): to the composer.
  useEffect(() => {
    if (target && isAgent(target.harness) && composerTarget(useLayout.getState())?.key === target.key) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.focusSeq]);

  return (
    <div className="flex min-h-0 flex-1">
      <section className="relative flex min-w-0 flex-1 flex-col px-5 pb-4">
        <LayoutView onCompose={() => composerRef.current?.focus()} />
        {target && (
          <>
            <div className={`mt-2.5 flex shrink-0 items-center gap-3 ${ended ? "pointer-events-none opacity-40" : ""}`}>
              <QuickKeys paneKey={target.key} harness={target.harness} />
              <span className="ml-auto truncate text-[11px] text-mist-500">
                {split ? (
                  <>
                    Typing to <span className="text-mist-300">{r(displayTitle(target))}</span> · click a split to switch
                  </>
                ) : (
                  <>Click the terminal to type into it directly · {keyLabel("Mod+F")} search · {keyLabel("Mod+Shift+G")} grid</>
                )}
              </span>
            </div>
            <ResizeHandle axis="y" size={composerHeight} direction={-1} onResize={(h) => ui().setComposerHeight(h)} resetTo={COMPOSER.default} className="mt-0.5" />
            {/* Pasted images get their own row on top of the text. */}
            <div className={`shrink-0 ${ended ? "pointer-events-none opacity-40" : ""}`} style={{ height: composerHeight + (attachments.length ? 60 : 0) }}>
              <Composer ref={composerRef} pane={target} onEscapeEmpty={() => backend().then((b) => b.sendKeys(target.key, ["Escape"]))} />
            </div>
          </>
        )}
      </section>

      {showFilmstrip && (
        <ResizeHandle axis="x" size={filmstripWidth} direction={-1} onResize={(w) => ui().setFilmstripWidth(w)} resetTo={FILMSTRIP.default} className="-mr-1.5" />
      )}
      {showFilmstrip && (
        <aside style={{ width: filmstripWidth }} className="flex shrink-0 flex-col border-l border-ink-700/80">
          <div className="flex h-12 shrink-0 items-center gap-1.5 px-2">
            <HeaderIcon onClick={() => ui().toggleFilmstrip()} title="Hide other panes">
              <PanelRightClose className="h-3.5 w-3.5" />
            </HeaderIcon>
            <span className="text-[10.5px] font-semibold tracking-[0.08em] text-mist-500 uppercase">Other panes</span>
            <span className="font-mono text-[10.5px] text-mist-600">{count}</span>
          </div>
          <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
            {others.map((p) => (
              <MiniTile key={p.key} pane={p} compact stale={hosts[p.host]?.phase.phase === "connected" ? null : "Offline"} home={hosts[p.host]?.facts?.home} />
            ))}
            {otherFiles.map((id) => (
              <FileTile key={id} id={id} home={hosts[files[id].host]?.facts?.home} showHost />
            ))}
          </div>
        </aside>
      )}
      {count > 0 && filmstripCollapsed && !maximized && (
        <aside className="flex w-10 shrink-0 justify-center border-l border-ink-700/80">
          <div className="flex h-12 items-center">
            <HeaderIcon onClick={() => ui().toggleFilmstrip()} title={waitingElsewhere > 0 ? `Show other panes (${waitingElsewhere} waiting)` : "Show other panes"}>
              <span className="relative block">
                <PanelRightOpen className="h-3.5 w-3.5" />
                {waitingElsewhere > 0 && <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-ember-400 ring-2 ring-ink-900" />}
              </span>
            </HeaderIcon>
          </div>
        </aside>
      )}
    </div>
  );
}
