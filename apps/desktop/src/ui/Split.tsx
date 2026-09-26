import { useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

/// A remembered, draggable size in layout pixels along `axis`.
/// The handle follows the mouse: size = mouse position inside the box, minus
/// where on the handle the press happened. Everything is measured in the
/// same client coordinates, so it cannot drift.
export function useSplit(key: string, initial: number, axis: Axis, min: number, max: number) {
  const [size, setSize] = useState<number>(() => { try { return Number(localStorage.getItem(key)) || initial; } catch { return initial; } });
  // Set on press: grab offset and the measured client-px-per-layout-px ratio.
  const drag = useRef<{ grab: number; ratio: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !box.current) return;
      const r = box.current.getBoundingClientRect();
      const mouse = axis === "x" ? e.clientX : e.clientY;
      const startEdge = axis === "x" ? r.left : r.top;
      const posClient = mouse - d.grab - startEdge; // handle's leading edge, client px from box start
      const next = posClient / d.ratio;
      const layout = axis === "x" ? box.current.clientWidth : box.current.clientHeight;
      const hardMax = Math.min(max, layout - 120); // keep the other pane usable
      setSize(Math.min(hardMax, Math.max(min, next)));
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
    const h = handle.current?.getBoundingClientRect();
    const b = box.current?.getBoundingClientRect();
    const mouse = axis === "x" ? e.clientX : e.clientY;
    const handleStart = h ? (axis === "x" ? h.left : h.top) : mouse;
    const boxStart = b ? (axis === "x" ? b.left : b.top) : 0;
    // The handle sits `size` layout px from the box start. Its measured client
    // distance divided by that is the exact client-to-layout ratio right now.
    const ratio = size > 0 && h && b ? (handleStart - boxStart) / size : 1;
    drag.current = { grab: mouse - handleStart, ratio: ratio > 0 ? ratio : 1 };
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
      className={`group relative flex shrink-0 items-center justify-center bg-stone-300 dark:bg-stone-700 ${vertical ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize"}`}
    >
      {/* wider invisible grab area so a 1px bar is still easy to hit */}
      <div className={`absolute ${vertical ? "inset-y-0 -left-1.5 w-3" : "inset-x-0 -top-1.5 h-3"}`} />
      <div className={`rounded-full bg-stone-400 group-hover:bg-teal-600 ${vertical ? "h-8 w-[5px]" : "h-[5px] w-8"}`} />
    </div>
  );
}
