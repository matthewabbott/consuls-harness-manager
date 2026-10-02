// A pill to pick one of a few things (machines, places, sessions) on the phone.

export default function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[14px] ring-1 ${
        on ? "bg-ember-400/15 text-ember-300 ring-ember-400/50" : "bg-ink-800 text-mist-200 ring-ink-700 active:bg-ink-700"
      }`}
    >
      {children}
    </button>
  );
}
