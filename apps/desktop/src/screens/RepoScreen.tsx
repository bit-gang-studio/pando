import { useCallback, useEffect, useRef, useState } from "react";
import { api, changed, type Overview as OverviewData } from "../lib/api";
import { navigate } from "../lib/routes";
import { CommitDetail } from "./CommitDetail";
import { CommitLog } from "./CommitLog";
import { Overview } from "./Overview";

const SPLIT_KEY = "pando.split";

export function RepoScreen({ root, commit, onError }: { root: string; commit: string | null; onError: (m: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [tick, setTick] = useState(0);
  const [top, setTop] = useState<number>(() => { try { return Number(localStorage.getItem(SPLIT_KEY)) || 40; } catch { return 40; } });
  const dragging = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try { setData(await api.overview(root)); setTick((t) => t + 1); }
    catch (e) { onError(String(e)); }
  }, [root, onError]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, 6000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !box.current) return;
      const r = box.current.getBoundingClientRect();
      const pct = Math.min(80, Math.max(15, ((e.clientY - r.top) / r.height) * 100));
      setTop(pct);
    };
    const up = () => { if (dragging.current) { dragging.current = false; try { localStorage.setItem(SPLIT_KEY, String(top)); } catch { /* ignore */ } } };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [top]);

  const branches = data?.branches.map((b) => b.branch.name) ?? [];
  const dirty = (data?.branches.filter((b) => b.worktree && changed(b.status) > 0).length ?? 0) + (data?.detached.filter((d) => changed(d.status) > 0).length ?? 0);
  const firstDirty = data?.branches.find((b) => b.worktree && changed(b.status) > 0)?.worktree?.path ?? data?.detached.find((d) => changed(d.status) > 0)?.worktree.path ?? null;

  return (
    <div ref={box} className="flex min-h-0 min-w-0 grow flex-col">
      <div style={{ height: `${top}%` }} className="flex min-h-0 flex-col">
        <CommitLog
          root={root}
          branches={branches}
          dirtyWorktrees={dirty}
          selected={commit}
          onSelect={(id) => navigate(id ? { kind: "commit", root, id } : { kind: "repo", root })}
          onUncommitted={() => firstDirty && navigate({ kind: "worktree", root, path: firstDirty })}
          refreshKey={tick}
        />
      </div>
      <div
        onMouseDown={() => { dragging.current = true; }}
        role="separator"
        aria-orientation="horizontal"
        className="h-1.5 shrink-0 cursor-row-resize border-y border-stone-300 bg-stone-200 hover:bg-teal-200 dark:border-stone-700 dark:bg-stone-700"
      />
      <div className="flex min-h-0 grow">
        {commit ? (
          <CommitDetail root={root} id={commit} onBack={() => navigate({ kind: "repo", root })} />
        ) : (
          <Overview root={root} data={data} onRefresh={refresh} onOpenDetail={(path) => navigate({ kind: "worktree", root, path })} onError={onError} />
        )}
      </div>
    </div>
  );
}
