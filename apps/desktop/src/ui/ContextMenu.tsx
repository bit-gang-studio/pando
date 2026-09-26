import { useEffect, useRef } from "react";

export type MenuItem = { label: string; onClick: () => void; danger?: boolean };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" style={{ left: x, top: y }} className="fixed z-50 min-w-[180px] rounded-md border border-stone-300 bg-white p-1 text-[13px] shadow-lg dark:border-stone-600 dark:bg-stone-800">
      {items.map((it) => (
        <button key={it.label} role="menuitem" onClick={() => { onClose(); it.onClick(); }} className={`block w-full rounded px-2.5 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-700 ${it.danger ? "text-red-700" : ""}`}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
