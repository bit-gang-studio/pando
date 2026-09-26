import { useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

function zoom(): number {
  const z = Number((document.documentElement.style as unknown as { zoom: string }).zoom);
  return z > 0 ? z : 1;
}

/// A remembered, draggable size. `size` is px for "x" or percent for "y".
/// Drags by delta from the press point, scaled by the page zoom, so the
/// handle stays under the mouse at any zoom level.
export function useSplit(key: string, initial: number, axis: Axis, min: number, max: number) {
  const [size, setSize] = useState<number>(() => { try { return Number(localStorage.getItem(key)) || initial; } catch { return initial; } });
  const drag = useRef<{ startPos: number; startSize: number; boxPx: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const delta = ((axis === "x" ? e.clientX : e.clientY) - d.startPos) / zoom();
      const next = axis === "x" ? d.startSize + delta : d.startSize + (delta / d.boxPx) * 100;
      setSize(Math.min(max, Math.max(min, next)));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setSize((s) => { try { localStorage.setItem(key, String(s)); } catch { /* ignore */ } return s; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [axis, key, min, max]);

  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const boxPx = box.current ? (axis === "x" ? box.current.clientWidth : box.current.clientHeight) : 1;
    drag.current = { startPos: axis === "x" ? e.clientX : e.clientY, startSize: size, boxPx };
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  };

  return { size, box, start };
}

export function SplitHandle({ axis, onMouseDown }: { axis: Axis; onMouseDown: (e: React.MouseEvent) => void }) {
  const vertical = axis === "x";
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      title="Drag to resize"
      className={`group flex shrink-0 items-center justify-center bg-stone-200 dark:bg-stone-700 ${vertical ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize"}`}
    >
      <div className={`rounded-full bg-stone-400 group-hover:bg-teal-600 ${vertical ? "h-10 w-1" : "h-1 w-10"}`} />
    </div>
  );
}
