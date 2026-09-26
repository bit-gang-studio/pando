import { useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

/// A remembered, draggable size. `size` is px for "x" or percent for "y".
export function useSplit(key: string, initial: number, axis: Axis, min: number, max: number) {
  const [size, setSize] = useState<number>(() => { try { return Number(localStorage.getItem(key)) || initial; } catch { return initial; } });
  const dragging = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !box.current) return;
      const r = box.current.getBoundingClientRect();
      const raw = axis === "x" ? e.clientX - r.left : ((e.clientY - r.top) / r.height) * 100;
      setSize(Math.min(max, Math.max(min, raw)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
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
    dragging.current = true;
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
