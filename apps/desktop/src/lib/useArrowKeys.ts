import { useCallback, useEffect, useRef } from "react";

/// Up/Down moves the selection in a list. Put the result on the list's
/// container with tabIndex={0}; clicking a row focuses it.
export function useArrowKeys<T>(items: T[], index: number, select: (item: T) => void) {
  // Remember where we moved to, so fast repeated presses don't reuse a stale index.
  const at = useRef(index);
  useEffect(() => { at.current = index; }, [index]);
  return useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (items.length === 0) return;
    e.preventDefault();
    const from = at.current;
    const next = from < 0 ? 0 : Math.max(0, Math.min(items.length - 1, from + (e.key === "ArrowDown" ? 1 : -1)));
    at.current = next;
    select(items[next]);
    // Keep the new row in view once it has re-rendered.
    const list = e.currentTarget;
    requestAnimationFrame(() => list.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" }));
  }, [items, select]);
}
