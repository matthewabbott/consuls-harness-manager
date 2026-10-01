import { Bell } from "lucide-react";

/** The phones' switch for tracking an agent (pushes when it's still waiting for you). */
export default function NotifySwitch({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <label className="flex shrink-0 flex-col items-center gap-1">
      <button
        role="switch"
        aria-checked={on}
        aria-label={on ? "Stop notifying for this agent" : "Notify when this agent waits for you"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={`relative h-[31px] w-[51px] rounded-full transition-colors ${on ? "bg-jade-400" : "bg-ink-600"}`}
      >
        <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-[left] ${on ? "left-[22px]" : "left-[2px]"}`} />
      </button>
      <span className={`flex items-center gap-0.5 text-[10.5px] font-medium ${on ? "text-jade-400" : "text-mist-500"}`}>
        <Bell className="h-2.5 w-2.5" /> Notify
      </span>
    </label>
  );
}
