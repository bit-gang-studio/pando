import { useCallback, useEffect, useState } from "react";
import { api, changed, type Overview as OverviewData } from "../lib/api";
import { navigate } from "../lib/routes";
import { CommitDetail } from "./CommitDetail";
import { CommitLog } from "./CommitLog";
import { RepoSidebar } from "./RepoSidebar";
import { UncommittedPanel } from "./UncommittedPanel";
import { Detail } from "./Detail";
import { SplitHandle, useSplit } from "../ui/Split";

type Props = { root: string; commit: string | null; worktree?: string | null; branch?: string | null; onError: (m: string) => void };

export function RepoScreen({ root, commit, worktree = null, branch = null, onError }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [tick, setTick] = useState(0);
  const [wtCommit, setWtCommit] = useState<string | null>(null); // selected commit while on a worktree
  const [firstId, setFirstId] = useState<string | null>(null); // newest commit, shown by default on the repo page
  // null = not chosen yet: show uncommitted changes if there are any, else the newest commit.
  const [uncommittedChoice, setShowUncommitted] = useState<boolean | null>(null);
  const split = useSplit("pando.split.graph.px", 300, "y", 120, 4000);
  const side = useSplit("pando.split.sidebar.px", 300, "x", 200, 700);
  const onLoaded = useCallback((id: string | null) => setFirstId(id), []);
  const [brCommit, setBrCommit] = useState<string | null>(null); // selected commit while on a branch
  const [brFirst, setBrFirst] = useState<string | null>(null); // newest commit on that branch
  useEffect(() => { setWtCommit(null); }, [worktree]);
  useEffect(() => { setBrCommit(null); setBrFirst(null); }, [branch]);
  const onBranchLoaded = useCallback((id: string | null) => setBrFirst(id), []);
  // Arriving at the plain repo page (not a commit, not a worktree) starts fresh:
  // Uncommitted changes if there are any, else the newest commit.
  useEffect(() => { if (!commit && !worktree && !branch) setShowUncommitted(null); }, [commit, worktree, branch]);

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
  const dirtyPaths = [
    ...(data?.branches.filter((b) => b.worktree && changed(b.status) > 0).map((b) => b.worktree!.path) ?? []),
    ...(data?.detached.filter((d) => changed(d.status) > 0).map((d) => d.worktree.path) ?? []),
  ];

  // Worktree mode: scope the log to its branch and treat "Uncommitted changes" as this worktree's.
  const wtRow = worktree ? data?.branches.find((b) => b.worktree?.path === worktree) ?? null : null;
  const wtDetached = worktree ? data?.detached.find((d) => d.worktree.path === worktree) ?? null : null;
  const wtBranch = wtRow?.branch.name ?? "";
  const wtDirty = worktree ? changed(wtRow?.status ?? wtDetached?.status ?? null) : 0;
  const showUncommitted = !worktree && !branch && (uncommittedChoice ?? (!commit && dirtyPaths.length > 0));
  const selected = worktree ? wtCommit : commit ?? firstId;

  const shown = worktree ? null : commit ?? firstId;
  return (
    <div ref={side.box} className="flex min-h-0 min-w-0 grow">
      <div style={{ width: side.size }} className="flex shrink-0 flex-col">
        <RepoSidebar root={root} data={data} current={worktree} currentBranch={branch} onOpenBranch={(name) => navigate({ kind: "branch", root, name })} onOpenRepo={() => navigate({ kind: "repo", root })} onRefresh={refresh} onOpenWorktree={(path) => navigate({ kind: "worktree", root, path })} onError={onError} />
      </div>
      <SplitHandle axis="x" onMouseDown={side.start} handleRef={side.handle} />
    <div ref={split.box} className="flex min-h-0 min-w-0 grow flex-col">
      <div style={{ height: split.size, flex: "0 0 auto" }} className="flex min-h-0 flex-col">
        <CommitLog
          root={root}
          scope={worktree ? wtBranch : branch ?? ""}
          dirtyWorktrees={branch ? 0 : worktree ? (wtDirty > 0 ? 1 : 0) : dirty}
          uncommittedLabel={worktree ? `${wtDirty} in this worktree` : undefined}
          selected={branch ? brCommit ?? brFirst : worktree ? selected : showUncommitted ? null : selected}
          uncommittedSelected={!worktree && showUncommitted}
          onSelect={(id) => { setShowUncommitted(false); if (branch) setBrCommit(id); else if (worktree) setWtCommit(id); else navigate(id ? { kind: "commit", root, id } : { kind: "repo", root }); }}
          onLoaded={branch ? onBranchLoaded : worktree ? undefined : onLoaded}
          onUncommitted={() => (worktree ? setWtCommit(null) : setShowUncommitted(true))}
          refreshKey={tick}
        />
      </div>
      <SplitHandle axis="y" onMouseDown={split.start} handleRef={split.handle} />
      <div className="flex min-h-0 grow">
        {branch ? (
          brCommit ?? brFirst ? <CommitDetail root={root} id={(brCommit ?? brFirst)!} /> : <div className="flex grow items-center justify-center text-body text-stone-500">Loading…</div>
        ) : worktree ? (
          wtCommit ? (
            <CommitDetail root={root} id={wtCommit} onBack={() => setWtCommit(null)} />
          ) : (
            <Detail root={root} path={worktree} onBack={() => navigate({ kind: "repo", root })} onChanged={refresh} />
          )
        ) : showUncommitted && dirtyPaths.length > 0 ? (
          <UncommittedPanel root={root} worktrees={dirtyPaths} />
        ) : shown ? (
          <CommitDetail root={root} id={shown} />
        ) : (
          <div className="flex grow items-center justify-center text-body text-stone-500">No commits yet.</div>
        )}
      </div>
    </div>
    </div>
  );
}
