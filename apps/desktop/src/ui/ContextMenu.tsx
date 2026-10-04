import { useLayer } from "../lib/keys";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/// A divider is written as `{ divider: true }`.
export type MenuItem = { label: string; onClick: () => void; danger?: boolean } | { divider: true };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  useLayer("overlay", onClose);
  return (
    <div ref={ref} role="menu" style={pos} className="fixed z-50 min-w-[180px] rounded-md border border-stone-300 bg-white p-1 text-body shadow-lg dark:border-stone-600 dark:bg-stone-800">
      {items.map((it, i) =>
        "divider" in it ? (
          i > 0 && i < items.length - 1 ? <div key={`d${i}`} className="my-1 border-t border-stone-200 dark:border-stone-700" /> : null
        ) : (
          <button key={it.label} role="menuitem" onClick={() => { onClose(); it.onClick(); }} className={`block w-full rounded px-2.5 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-700 ${it.danger ? "text-red-700" : ""}`}>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
