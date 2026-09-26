import { useCallback, useEffect, useState } from "react";
import { api, changed, type Overview as OverviewData } from "../lib/api";
import { navigate } from "../lib/routes";
import { CommitDetail } from "./CommitDetail";
import { CommitLog } from "./CommitLog";
import { Overview } from "./Overview";
import { Detail } from "./Detail";
import { SplitHandle, useSplit } from "../ui/Split";

type Props = { root: string; commit: string | null; worktree?: string | null; onError: (m: string) => void };

export function RepoScreen({ root, commit, worktree = null, onError }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [tick, setTick] = useState(0);
  const [wtCommit, setWtCommit] = useState<string | null>(null); // selected commit while on a worktree
  const split = useSplit(worktree ? "pando.split.worktree.px" : "pando.split.repo.px", worktree ? 240 : 320, "y", 120, 4000);
  useEffect(() => { setWtCommit(null); }, [worktree]);

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

  const dirty = (data?.branches.filter((b) => b.worktree && changed(b.status) > 0).length ?? 0) + (data?.detached.filter((d) => changed(d.status) > 0).length ?? 0);
  const firstDirty = data?.branches.find((b) => b.worktree && changed(b.status) > 0)?.worktree?.path ?? data?.detached.find((d) => changed(d.status) > 0)?.worktree.path ?? null;

  // Worktree mode: scope the log to its branch and treat "Uncommitted changes" as this worktree's.
  const wtRow = worktree ? data?.branches.find((b) => b.worktree?.path === worktree) ?? null : null;
  const wtDetached = worktree ? data?.detached.find((d) => d.worktree.path === worktree) ?? null : null;
  const wtBranch = wtRow?.branch.name ?? "";
  const wtDirty = worktree ? changed(wtRow?.status ?? wtDetached?.status ?? null) : 0;
  const selected = worktree ? wtCommit : commit;

  return (
    <div ref={split.box} className="flex min-h-0 min-w-0 grow flex-col">
      <div style={{ height: split.size, flex: "0 0 auto" }} className="flex min-h-0 flex-col">
        <CommitLog
          root={root}
          scope={worktree ? wtBranch : ""}
          dirtyWorktrees={worktree ? (wtDirty > 0 ? 1 : 0) : dirty}
          uncommittedLabel={worktree ? `${wtDirty} in this worktree` : undefined}
          selected={selected}
          onSelect={(id) => (worktree ? setWtCommit(id) : navigate(id ? { kind: "commit", root, id } : { kind: "repo", root }))}
          onUncommitted={() => (worktree ? setWtCommit(null) : firstDirty && navigate({ kind: "worktree", root, path: firstDirty }))}
          refreshKey={tick}
        />
      </div>
      <SplitHandle axis="y" onMouseDown={split.start} handleRef={split.handle} />
      <div className="flex min-h-0 grow">
        {worktree ? (
          wtCommit ? (
            <CommitDetail root={root} id={wtCommit} onBack={() => setWtCommit(null)} />
          ) : (
            <Detail root={root} path={worktree} onBack={() => navigate({ kind: "repo", root })} onChanged={refresh} />
          )
        ) : commit ? (
          <CommitDetail root={root} id={commit} onBack={() => navigate({ kind: "repo", root })} />
        ) : (
          <Overview root={root} data={data} onRefresh={refresh} onOpenDetail={(path) => navigate({ kind: "worktree", root, path })} onError={onError} />
        )}
      </div>
    </div>
  );
}
