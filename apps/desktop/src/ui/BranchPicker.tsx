import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLayer } from "../lib/keys";

/// `where`: why it can't be picked ("in web-spaces", "checked out here").
/// `note`: something worth knowing about it that doesn't stop it being picked ("in web-spaces").
export type PickBranch = { name: string; where?: string; note?: string };

/// A searchable list of branches, opened at a point. Branches that can't be
/// picked stay in the list, greyed, saying where they are.
export function BranchPicker({ x, y, branches, hint, label = "Switch branch", onPick, onClose }: { x: number; y: number; branches: PickBranch[]; hint?: string; label?: string; onPick: (name: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = branches.filter((b) => words.every((w) => b.name.toLowerCase().includes(w)));
    // What you can pick comes first.
    return [...hit.filter((b) => !b.where), ...hit.filter((b) => b.where)];
  }, [branches, q]);
  const free = shown.filter((b) => !b.where);
  // Keep the list inside the window.
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
  const pick = (name: string) => { onClose(); onPick(name); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, free.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && free[at]) { e.preventDefault(); pick(free[at].name); }
  };
  return (
    <div ref={ref} role="dialog" aria-label={label} style={pos} onClick={(e) => e.stopPropagation()} className="fixed z-50 w-72 rounded-md border border-stone-300 bg-white text-body shadow-lg dark:border-stone-600 dark:bg-stone-800">
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} onKeyDown={onKey} placeholder="Find a branch" aria-label="Find a branch" className="w-full rounded-t-md border-b border-stone-200 bg-transparent px-2.5 py-1.5 outline-none dark:border-stone-700" />
      <div role="listbox" onMouseDown={(e) => e.preventDefault()} className="max-h-64 overflow-y-auto p-1">
        {shown.length === 0 && <div className="px-2.5 py-1.5 text-stone-500">No branch matches.</div>}
        {shown.map((b) => {
          const i = free.indexOf(b);
          return b.where ? (
            <div key={b.name} role="option" aria-selected={false} aria-disabled className="flex items-center gap-2 px-2.5 py-1.5 text-stone-400" title="Git allows a branch in one worktree at a time.">
              <span className="min-w-0 truncate font-mono">{b.name}</span><span className="ml-auto shrink-0 text-label">{b.where}</span>
            </div>
          ) : (
            <button key={b.name} role="option" aria-selected={i === at} onMouseEnter={() => setAt(i)} onClick={() => pick(b.name)} className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left ${i === at ? "bg-stone-100 dark:bg-stone-700" : ""}`}>
              <span className="min-w-0 truncate font-mono">{b.name}</span>{b.note && <span className="ml-auto shrink-0 text-label text-stone-500">{b.note}</span>}
            </button>
          );
        })}
      </div>
      {hint && <div className="border-t border-stone-200 px-2.5 py-1.5 text-label text-stone-500 dark:border-stone-700">{hint}</div>}
    </div>
  );
}
