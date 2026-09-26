import { useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

/// A remembered, draggable size. `size` is px for "x" or percent for "y".
/// The handle follows the mouse: size = mouse position inside the box, minus
/// where on the handle the press happened. Everything is measured in the
/// same client coordinates, so it cannot drift.
export function useSplit(key: string, initial: number, axis: Axis, min: number, max: number) {
  const [size, setSize] = useState<number>(() => { try { return Number(localStorage.getItem(key)) || initial; } catch { return initial; } });
  const grab = useRef<number | null>(null); // offset from handle start to press point, client px
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (grab.current === null || !box.current) return;
      const r = box.current.getBoundingClientRect();
      const mouse = axis === "x" ? e.clientX : e.clientY;
      const startEdge = axis === "x" ? r.left : r.top;
      const extent = axis === "x" ? r.width : r.height;
      const posClient = mouse - grab.current - startEdge; // handle's leading edge, client px from box start
      // Convert client px to layout px via the box's own ratio (1 unless zoomed).
      const layout = axis === "x" ? box.current.clientWidth : box.current.clientHeight;
      const scale = layout > 0 && extent > 0 ? extent / layout : 1;
      const next = axis === "x" ? posClient / scale : (posClient / extent) * 100;
      setSize(Math.min(max, Math.max(min, next)));
    };
    const up = () => {
      if (grab.current === null) return;
      grab.current = null;
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
    const h = handle.current?.getBoundingClientRect();
    const mouse = axis === "x" ? e.clientX : e.clientY;
    grab.current = h ? mouse - (axis === "x" ? h.left : h.top) : 0;
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  };

  return { size, box, handle, start };
}

export function SplitHandle({ axis, onMouseDown, handleRef }: { axis: Axis; onMouseDown: (e: React.MouseEvent) => void; handleRef: React.RefObject<HTMLDivElement | null> }) {
  const vertical = axis === "x";
  return (
    <div
      ref={handleRef}
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
