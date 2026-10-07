// A sheet from the bottom of the screen: a menu of actions, or a small form.

export function Sheet({ onClose, children }: { onClose(): void; children: React.ReactNode }) {
  return (
    <div className="overlay z-40 flex flex-col justify-end bg-ink-950/60" onClick={onClose}>
      <div className="safe-bottom max-h-[92%] overflow-y-auto rounded-t-3xl bg-ink-850 px-3 pt-3 ring-1 ring-ink-700" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function SheetAction({ onClick, danger = false, children }: { onClick(): void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left text-[16px] active:bg-ink-700 ${danger ? "text-rose-400" : "text-mist-100"}`}
    >
      {children}
    </button>
  );
}
