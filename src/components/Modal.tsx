import { X } from "lucide-react";
import { useEffect } from "react";

interface Props {
  title: React.ReactNode;
  onClose(): void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}

export default function Modal({ title, onClose, children, footer, width = 560 }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/60 p-6 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className="animate-rise flex max-h-full w-full flex-col overflow-hidden rounded-2xl bg-ink-800 shadow-2xl ring-1 ring-ink-600"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-700 px-5 py-3.5">
          <div className="min-w-0 flex-1 font-display text-[15px] font-semibold text-mist-100">{title}</div>
          <button onClick={onClose} className="rounded-md p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-ink-700 bg-ink-850/60 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Button({
  onClick,
  children,
  kind = "secondary",
  disabled,
  type = "button",
}: {
  onClick?: () => void;
  children: React.ReactNode;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const cls = {
    primary: "bg-sky-400 text-ink-950 hover:bg-[#82b8ff]",
    secondary: "bg-ink-700 text-mist-200 hover:bg-ink-600",
    danger: "bg-rose-400 text-ink-950 hover:bg-[#ff8295]",
  }[kind];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}
