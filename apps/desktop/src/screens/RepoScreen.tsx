import { useCallback, useEffect, useState } from "react";
import { api, changed, type Overview as OverviewData } from "../lib/api";
import { navigate } from "../lib/routes";
import { CommitDetail } from "./CommitDetail";
import { CommitLog } from "./CommitLog";
import { RepoSidebar } from "./RepoSidebar";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { confirm } from "../ui/Confirm";
import { openInNewWindow } from "../lib/windows";
import type { LogEntry } from "../lib/api";
import { UncommittedPanel } from "./UncommittedPanel";
import { Detail } from "./Detail";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading } from "../ui/State";
import { withToast } from "../ui/Toast";
import { errorParts } from "../lib/errors";

type Props = { root: string; commit: string | null; worktree?: string | null; branch?: string | null };

export function RepoScreen({ root, commit, worktree = null, branch = null }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [wtCommit, setWtCommit] = useState<string | null>(null); // selected commit while on a worktree
  const [firstId, setFirstId] = useState<string | null>(null); // newest commit, shown by default on the repo page
  // null = not chosen yet: show uncommitted changes if there are any, else the newest commit.
  const [uncommittedChoice, setShowUncommitted] = useState<boolean | null>(null);
  const split = useSplit("pando.split.graph.px", 300, "y", 120, 4000);
  const side = useSplit("pando.split.sidebar.px", 300, "x", 260, 700);
  const onLoaded = useCallback((id: string | null) => setFirstId(id), []);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [brCommit, setBrCommit] = useState<string | null>(null); // selected commit while on a branch
  const [brFirst, setBrFirst] = useState<string | null>(null); // newest commit on that branch
  useEffect(() => { setWtCommit(null); }, [worktree]);
  useEffect(() => { setBrCommit(null); setBrFirst(null); }, [branch]);
  const onBranchLoaded = useCallback((id: string | null) => setBrFirst(id), []);
  // Arriving at the plain repo page (not a commit, not a worktree) starts fresh:
  // Uncommitted changes if there are any, else the newest commit.
  useEffect(() => { if (!commit && !worktree && !branch) setShowUncommitted(null); }, [commit, worktree, branch]);

  const refresh = useCallback(async () => {
    try { setData(await api.overview(root)); setLoadError(null); setTick((t) => t + 1); }
    catch (e) { setLoadError(String(e)); }
  }, [root]);

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

  // Same dot colours as the sidebar, so "a dot means a worktree has it checked out".
  const dotFor = (st: import("../lib/api").Summary | null, missing: boolean, isMain: boolean) =>
    missing || (st?.conflicts ?? 0) > 0 ? "bg-red-700" : changed(st) > 0 ? "bg-amber-700" : isMain ? "bg-stone-400" : "bg-teal-700";
  const branchDots: Record<string, string> = {};
  const detachedDots: Record<string, string[]> = {};
  const heads = new Set<string>();
  for (const b of data?.branches ?? []) {
    if (!b.worktree) continue;
    branchDots[b.branch.name] = dotFor(b.status, !!b.worktree.prunable, b.is_main_worktree);
    if (b.worktree.head) heads.add(b.worktree.head);
  }
  for (const d of data?.detached ?? []) {
    if (!d.worktree.head) continue;
    (detachedDots[d.worktree.head] ??= []).push(dotFor(d.status, !!d.worktree.prunable, d.is_main_worktree));
    heads.add(d.worktree.head);
  }

  // Worktree mode: scope the log to its branch and treat "Uncommitted changes" as this worktree's.
  const wtRow = worktree ? data?.branches.find((b) => b.worktree?.path === worktree) ?? null : null;
  const wtDetached = worktree ? data?.detached.find((d) => d.worktree.path === worktree) ?? null : null;
  const wtBranch = wtRow?.branch.name ?? "";
  const wtDirty = worktree ? changed(wtRow?.status ?? wtDetached?.status ?? null) : 0;
  // ---- right-click on a commit ----------------------------------------------
  const worktreeOptions = () => [
    ...(data?.branches.filter((b) => b.worktree).map((b) => ({ value: b.worktree!.path, label: b.branch.name + (b.is_main_worktree ? " (main worktree)" : "") })) ?? []),
    ...(data?.detached.map((d) => ({ value: d.worktree.path, label: `detached at ${d.worktree.head?.slice(0, 7)}` })) ?? []),
  ];
  const mainPath = data?.branches.find((b) => b.is_main_worktree)?.worktree?.path ?? data?.detached.find((d) => d.is_main_worktree)?.worktree.path;
  async function act(doing: string, done: string, fn: () => Promise<unknown>) {
    await withToast(doing, done, fn);
    await refresh();
  }
  async function applyCommit(entry: LogEntry, kind: "pick" | "revert") {
    const verb = kind === "pick" ? "Cherry-pick" : "Revert";
    const a = await confirm({
      title: verb,
      body: <><span className="font-mono">{entry.id.slice(0, 7)}</span> {entry.summary}</>,
      action: verb,
      select: { label: kind === "pick" ? "Into worktree" : "In worktree", options: worktreeOptions(), value: worktree ?? mainPath },
    });
    if (!a.ok) return;
    await act(kind === "pick" ? "Cherry-picking…" : "Reverting…", kind === "pick" ? "Cherry-picked" : "Reverted", async () => {
      const r = kind === "pick" ? await api.cherryPick(root, a.choice, entry.id) : await api.revert(root, a.choice, entry.id);
      if (r === "paused") navigate({ kind: "worktree", root, path: a.choice });
    });
  }
  const commitMenu = (e: React.MouseEvent, entry: LogEntry) => {
    const sep: MenuItem = { divider: true };
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "Open in new window", onClick: () => openInNewWindow({ kind: "commit", root, id: entry.id }) },
      { label: "Copy commit id", onClick: () => navigator.clipboard.writeText(entry.id) },
      sep,
      { label: "Create branch here…", onClick: async () => {
        const a = await confirm({ title: "Create branch", body: <>Start a branch at <span className="font-mono">{entry.id.slice(0, 7)}</span> {entry.summary}</>, action: "Create branch", input: { label: "Branch name", placeholder: "feat/my-change", mono: true }, checkbox: { label: "Add a worktree for it", checked: true } });
        if (!a.ok) return;
        await act("Creating branch…", `Created ${a.value}`, () => a.checked
          ? api.worktreeAdd(root, { branch: a.value, base: entry.id, path: null, existing_branch: false })
          : api.branchCreate(root, a.value, entry.id));
      } },
      { label: "Cherry-pick…", onClick: () => applyCommit(entry, "pick") },
      { label: "Revert…", onClick: () => applyCommit(entry, "revert") },
      { label: "Tag…", onClick: async () => {
        const a = await confirm({ title: "Tag commit", body: <><span className="font-mono">{entry.id.slice(0, 7)}</span> {entry.summary}</>, action: "Create tag", input: { label: "Tag name", placeholder: "v1.0.0", mono: true }, checkbox: { label: "Push to origin" } });
        if (a.ok) await act("Tagging…", `Tagged ${a.value}`, () => api.tagCreate(root, a.value, entry.id, null, a.checked));
      } },
    ] });
  };

  const showUncommitted = !worktree && !branch && (uncommittedChoice ?? (!commit && dirtyPaths.length > 0));
  const selected = worktree ? wtCommit : commit ?? firstId;

  const shown = worktree ? null : commit ?? firstId;
  if (!data && loadError) return <ErrorState title="Couldn't open this repository" error={loadError} onRetry={refresh} />;
  if (!data) return <Loading />;
  return (
    <div ref={side.box} className="flex min-h-0 min-w-0 grow">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <div style={{ width: side.size }} className="flex shrink-0 flex-col">
        <RepoSidebar root={root} data={data} current={worktree} currentBranch={branch} onOpenBranch={(name) => navigate({ kind: "branch", root, name })} onOpenRepo={() => navigate({ kind: "repo", root })} onRefresh={refresh} onOpenWorktree={(path) => navigate({ kind: "worktree", root, path })} />
      </div>
      <SplitHandle axis="x" onMouseDown={side.start} handleRef={side.handle} />
    <div ref={split.box} className="flex min-h-0 min-w-0 grow flex-col">
      {loadError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-body text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <span className="selectable min-w-0 grow truncate">Couldn't refresh: {errorParts(loadError).message}</span>
          <button onClick={refresh} className="underline">Retry</button>
        </div>
      )}
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
          onCommitMenu={commitMenu}
          branchDots={branchDots}
          detachedDots={detachedDots}
          heads={heads}
          refreshKey={tick}
        />
      </div>
      <SplitHandle axis="y" onMouseDown={split.start} handleRef={split.handle} />
      <div className="flex min-h-0 grow">
        {branch ? (
          brCommit ?? brFirst ? <CommitDetail root={root} id={(brCommit ?? brFirst)!} /> : <Loading />
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
