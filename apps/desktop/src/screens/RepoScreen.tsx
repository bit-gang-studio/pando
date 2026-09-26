import { useCallback, useEffect, useState } from "react";
import { api, changed, type Overview as OverviewData } from "../lib/api";
import { navigate } from "../lib/routes";
import { CommitDetail } from "./CommitDetail";
import { CommitLog } from "./CommitLog";
import { Overview } from "./Overview";
import { SplitHandle, useSplit } from "../ui/Split";

export function RepoScreen({ root, commit, onError }: { root: string; commit: string | null; onError: (m: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [tick, setTick] = useState(0);
  const split = useSplit("pando.split.repo", 40, "y", 15, 80);

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

  const branches = data?.branches.map((b) => b.branch.name) ?? [];
  const dirty = (data?.branches.filter((b) => b.worktree && changed(b.status) > 0).length ?? 0) + (data?.detached.filter((d) => changed(d.status) > 0).length ?? 0);
  const firstDirty = data?.branches.find((b) => b.worktree && changed(b.status) > 0)?.worktree?.path ?? data?.detached.find((d) => changed(d.status) > 0)?.worktree.path ?? null;

  return (
    <div ref={split.box} className="flex min-h-0 min-w-0 grow flex-col">
      <div style={{ height: `${split.size}%` }} className="flex min-h-0 flex-col">
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
      <SplitHandle axis="y" onMouseDown={split.start} handleRef={split.handle} />
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
