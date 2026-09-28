import { SIDEBAR, useUi } from "../store/ui";
import ActivityBar from "./ActivityBar";
import ResizeHandle from "./ResizeHandle";
import FilesPanel from "./FilesPanel";
import MachinesPanel from "./Sidebar";

export default function LeftSidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const maximized = useUi((s) => s.maximized);
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const tab = useUi((s) => s.sidebarTab);

  return (
    <div className="flex h-full shrink-0">
      <ActivityBar />
      {!collapsed && !maximized && (
        <>
          <aside style={{ width }} className="flex shrink-0 flex-col border-r border-ink-700/80 bg-ink-950/40">
            {tab === "machines" && <MachinesPanel />}
            {tab === "files" && <FilesPanel />}
          </aside>
          <ResizeHandle axis="x" size={width} direction={1} onResize={setWidth} resetTo={SIDEBAR.default} className="-ml-1.5" />
        </>
      )}
    </div>
  );
}
