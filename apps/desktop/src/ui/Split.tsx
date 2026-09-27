import { useEffect, useRef, useState } from "react";

type Axis = "x" | "y";

/// A remembered, draggable size in pixels along `axis`. The handle follows the
/// mouse: size = mouse position inside the box, minus where on the handle the
/// press happened. Page zoom is the webview's own, so coordinates stay consistent.
export function useSplit(key: string, initial: number, axis: Axis, min: number, max: number) {
  const [size, setSize] = useState<number>(() => {
    let v = initial;
    try { v = Number(localStorage.getItem(key)) || initial; } catch { /* ignore */ }
    return Math.min(max, Math.max(min, v)); // a saved size may predate a new minimum
  });
  const grab = useRef<number | null>(null); // offset from handle start to press point
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (grab.current === null || !box.current) return;
      const r = box.current.getBoundingClientRect();
      const mouse = axis === "x" ? e.clientX : e.clientY;
      const startEdge = axis === "x" ? r.left : r.top;
      const next = mouse - grab.current - startEdge; // handle's leading edge, from the box start
      const layout = axis === "x" ? box.current.clientWidth : box.current.clientHeight;
      const hardMax = Math.min(max, layout - 120); // keep the other pane usable
      setSize(Math.min(hardMax, Math.max(min, next)));
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
      className={`group relative flex shrink-0 items-center justify-center bg-stone-300 dark:bg-stone-700 ${vertical ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize"}`}
    >
      {/* wider invisible grab area so a 1px bar is still easy to hit */}
      <div className={`absolute ${vertical ? "inset-y-0 -left-1.5 w-3" : "inset-x-0 -top-1.5 h-3"}`} />
      <div className={`rounded-full bg-stone-400 group-hover:bg-teal-600 ${vertical ? "h-8 w-[3px]" : "h-[3px] w-8"}`} />
    </div>
  );
}
