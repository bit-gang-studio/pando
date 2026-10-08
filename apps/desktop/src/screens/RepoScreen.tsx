import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, changed, type Overview as OverviewData } from "../lib/api";
import { navigate, toHash } from "../lib/routes";
import { CommitDetail } from "./CommitDetail";
import { CommitLog, type Span } from "./CommitLog";
import { RepoSidebar } from "./RepoSidebar";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { confirm } from "../ui/Confirm";
import { openInNewWindow } from "../lib/windows";
import type { LogEntry } from "../lib/api";
import { UncommittedPanel } from "./UncommittedPanel";
import { Detail } from "./Detail";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading } from "../ui/State";
import { toastDone, toastError, withToast } from "../ui/Toast";
import { MessageDialog } from "../dialogs/MessageDialog";
import { PullRequestDialog } from "../dialogs/PullRequestDialog";
import { FileView, type FileTarget } from "./FileView";
import { FilesPage, type FilesTarget } from "./FilesPage";
import { setCenterView, useCenterView } from "../lib/view";
import { getChosenBase } from "../lib/base";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Rewritten } from "../lib/api";
import { errorParts } from "../lib/errors";
import { useRepoRefresh, watchRepo } from "../lib/watch";
import { dot, worktreeOptions } from "../lib/worktrees";
import { usePullRequests } from "../lib/prs";
import type { Overlap } from "../lib/api";

type Props = { root: string; commit: string | null; worktree?: string | null; branch?: string | null; /** Just opened: start on the base. */ land?: boolean };

export function RepoScreen({ root, commit, worktree = null, branch = null, land = false }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const [tick, setTick] = useState(0);
  // Goes up only when a branch, tag or worktree HEAD moved. The commit list and
  // everything else that depends on refs reloads on this, not on every file change.
  const [refsTick, setRefsTick] = useState(0);
  const refsKey = useRef<string | null>(null);
  const [wtCommit, setWtCommit] = useState<string | null>(null); // selected commit while on a worktree
  const [firstId, setFirstId] = useState<string | null>(null); // newest commit, shown by default on the repo page
  // null = not chosen yet: show uncommitted changes if there are any, else the newest commit.
  const [uncommittedChoice, setShowUncommitted] = useState<boolean | null>(null);
  const split = useSplit("pando.split.graph.px", 300, "y", 120, 4000);
  const side = useSplit("pando.split.sidebar.px", 300, "x", 260, 700);
  const onLoaded = useCallback((id: string | null) => setFirstId(id), []);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [baseFor, setBaseFor] = useState<Record<string, string>>({}); // picked compare base, per branch
  const [brCommit, setBrCommit] = useState<string | null>(null); // selected commit while on a branch
  const [brFirst, setBrFirst] = useState<string | null>(null); // newest commit on that branch
  // "All changes" vs base: shown first on a branch, offered on a worktree.
  const [brCompare, setBrCompare] = useState(true);
  const [wtCompare, setWtCompare] = useState(false);
  // Several commits picked with shift-click, shown as one diff.
  const [span, setSpan] = useState<Span | null>(null);
  const [spanIds, setSpanIds] = useState<string[] | null>(null); // the commits it adds up, once known
  // One file's history or blame, shown in place of the details.
  const [fileView, setFileView] = useState<FileTarget | null>(null);
  const pickSpan = (s: Span | null) => { setSpan(s); setSpanIds(null); setFileView(null); };
  useEffect(() => { setSpan(null); setSpanIds(null); setFileView(null); }, [root, worktree, branch, commit]);
  const picked = useMemo(() => (span ? new Set(spanIds ?? [span.older, span.newer]) : undefined), [span, spanIds]);
  useEffect(() => { setWtCommit(null); setWtCompare(false); }, [worktree]);
  useEffect(() => { setBrCommit(null); setBrFirst(null); setBrCompare(true); }, [branch]);
  const onBranchLoaded = useCallback((id: string | null) => setBrFirst(id), []);
  // Arriving at the plain repo page (not a commit, not a worktree) starts fresh:
  // Uncommitted changes if there are any, else the newest commit.
  useEffect(() => { if (!commit && !worktree && !branch) setShowUncommitted(null); }, [commit, worktree, branch]);

  const refresh = useCallback(async () => {
    try {
      const show = (next: OverviewData) => {
        setData(next);
        if (!next.refs_key || next.refs_key !== refsKey.current) { refsKey.current = next.refs_key ?? null; setRefsTick((t) => t + 1); }
      };
      // First load: show branches and worktrees at once, then fill in changes.
      if (!loadedRef.current) { show(await api.overview(root, true, getChosenBase(root))); loadedRef.current = true; }
      show(await api.overview(root, false, getChosenBase(root))); setLoadError(null); setTick((t) => t + 1);
    }
    catch (e) { setLoadError(String(e)); }
  }, [root]);

  useRepoRefresh(root, refresh);
  const { prs, byBranch: prByBranch, reload: reloadPrs } = usePullRequests(root);
  // Overlaps: a moment after each full refresh, so a burst of changes checks once.
  const [overlaps, setOverlaps] = useState<Overlap[]>([]);
  const statusLoaded = !!data?.status_loaded;
  useEffect(() => {
    if (!statusLoaded) return;
    const t = setTimeout(() => { api.overlaps(root).then((o) => setOverlaps(o ?? [])).catch(() => setOverlaps([])); }, 1500);
    return () => clearTimeout(t);
  }, [root, tick, statusLoaded]);
  // Fetch quietly on open and every 5 minutes while the window is in use, so
  // ahead/behind stays current. Failures (offline, needs a login) stay silent;
  // the Fetch button shows them.
  useEffect(() => {
    const quiet = () => { if (document.hasFocus()) api.fetchAll(root).then(refresh).catch(() => {}); reloadPrs(); };
    const first = setTimeout(quiet, 3000);
    const t = setInterval(quiet, 5 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [root, refresh, reloadPrs]);
  // Watch every worktree folder; re-watch when the set changes.
  const wtKey = [...(data?.branches.flatMap((b) => (b.worktree ? [b.worktree.path] : [])) ?? []), ...(data?.detached.map((d) => d.worktree.path) ?? [])].join("\0");
  useEffect(() => { if (data) watchRepo(root, wtKey.split("\0").filter(Boolean)); }, [root, wtKey, !!data]);

  const dirty = (data?.branches.filter((b) => b.worktree && changed(b.status) > 0).length ?? 0) + (data?.detached.filter((d) => changed(d.status) > 0).length ?? 0);
  const dirtyPaths = [
    ...(data?.branches.filter((b) => b.worktree && changed(b.status) > 0).map((b) => b.worktree!.path) ?? []),
    ...(data?.detached.filter((d) => changed(d.status) > 0).map((d) => d.worktree.path) ?? []),
  ];

  // Same dot colours as the sidebar, so "a dot means a worktree has it checked out".
  const dotFor = (status: import("../lib/api").Summary | null, missing: boolean, isMain: boolean) =>
    dot({ status, missing, isMain, loaded: !!data?.status_loaded }).cls;
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
      select: { label: kind === "pick" ? "Into worktree" : "In worktree", options: worktreeOptions(data), value: worktree ?? mainPath },
    });
    if (!a.ok) return;
    await act(kind === "pick" ? "Cherry-picking…" : "Reverting…", kind === "pick" ? "Cherry-picked" : "Reverted", async () => {
      const r = kind === "pick" ? await api.cherryPick(root, a.choice, entry.id) : await api.revert(root, a.choice, entry.id);
      if (r === "paused") navigate({ kind: "worktree", root, path: a.choice });
    });
  }
  // ---- clean up commits: reword, squash, drop -----------------------------------
  async function rewritten(r: Rewritten, done: string) {
    pickSpan(null); setWtCommit(null); setBrCommit(null);
    if (!r.paused) toastDone(done, { run: () => api.rewriteUndo(root, r.branch, r.new_tip, r.old_tip), after: refresh });
    await refresh();
  }
  /// Menu items for a commit that hasn't been pushed, on this page's branch.
  function rewriteItems(entry: LogEntry): MenuItem[] {
    if (!head || !editable.has(entry.id)) return [];
    const on = head;
    const short = entry.id.slice(0, 7);
    const upstream = data?.branches.find((b) => b.branch.name === on)?.branch.upstream;
    const after = (ids: string[]) => (ids.some((id) => pushed.has(id)) ? <> Already on <span className="font-mono">{upstream ?? "the remote"}</span>, so you'll force push afterwards.</> : null);
    const items: MenuItem[] = [{ divider: true }, {
      label: "Reword…",
      onClick: () => setMsgDlg({
        title: "Reword commit", action: "Reword",
        body: <>Change the message of <span className="font-mono">{short}</span> on <span className="font-mono">{on}</span>. Files don't change.{after([entry.id])}</>,
        initial: api.commitDiff(root, entry.id).then((c) => c.message),
        onSubmit: async (m) => rewritten(await api.commitReword(root, on, entry.id, m), `Reworded ${short}`),
      }),
    }];
    // Several picked with shift-click, or this one into the one before it. Oldest first.
    const run = span && spanIds && spanIds.length > 1 && spanIds.includes(entry.id) && spanIds.every((id) => editable.has(id))
      ? [...spanIds].reverse()
      : entry.parents.length === 1 && editable.has(entry.parents[0]) ? [entry.parents[0], entry.id] : null;
    if (run) {
      const older = run[0], newer = run[run.length - 1];
      items.push({
        label: run.length > 2 || span ? `Squash ${run.length} commits…` : "Squash into previous…",
        onClick: () => setMsgDlg({
          title: `Squash ${run.length} commits`, action: "Squash",
          body: <>Make one commit out of <span className="font-mono">{older.slice(0, 7)}</span> to <span className="font-mono">{newer.slice(0, 7)}</span> on <span className="font-mono">{on}</span>. Files don't change.{after(run)}</>,
          // The oldest commit's message, then the others' underneath.
          initial: Promise.all(run.slice(0, 30).map((id) => api.commitDiff(root, id).then((c) => c.message.trim()))).then((all) => all.join("\n\n")),
          onSubmit: async (m) => rewritten(await api.commitSquash(root, on, older, newer, m), `Squashed ${run.length} commits`),
        }),
      });
    }
    // Dropping changes files, so it needs the branch's worktree: this page.
    if (worktree && entry.parents.length === 1) {
      items.push({ label: "Drop…", danger: true, onClick: async () => {
        const a = await confirm({ title: "Drop commit", body: <>Remove <span className="font-mono">{short}</span> {entry.summary} and its changes from <span className="font-mono">{on}</span>? You can undo this.{after([entry.id])}</>, action: "Drop commit", danger: true });
        if (!a.ok) return;
        try {
          const r = await api.commitDrop(root, on, entry.id);
          if (r.paused) toastDone("Later commits conflict without it. Resolve them, then Continue, or Abort to put it back.");
          await rewritten(r, `Dropped ${short}`);
        } catch (err) { toastError(err); }
      } });
    }
    return items;
  }
  // ---- right-click on a file: its history, or who changed each line ---------------
  const fileMenu = (rev: string | null, wt: string | null) => (e: React.MouseEvent, path: string) => {
    // History needs a commit to start from: a worktree's own HEAD, not the main one's.
    const from = rev ?? data?.branches.find((b) => b.worktree?.path === wt)?.worktree?.head ?? data?.detached.find((d) => d.worktree.path === wt)?.worktree.head ?? null;
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "File history", onClick: () => setFileView({ path, rev: from, worktree: null, mode: "history" }) },
      { label: "Blame", onClick: () => setFileView({ path, rev, worktree: rev ? null : wt, mode: "blame" }) },
      { divider: true },
      { label: "Copy path", onClick: () => navigator.clipboard.writeText(path) },
    ] });
  };
  /// Open a commit from the file view, wherever we are.
  const showCommit = (id: string) => {
    setFileView(null);
    if (branch) { setBrCompare(false); setBrCommit(id); }
    else if (worktree) { setWtCompare(false); setWtCommit(id); }
    else navigate({ kind: "commit", root, id });
  };
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
      ...entry.refs.filter((r) => r.startsWith("tag: ")).flatMap((r): MenuItem[] => {
        const tag = r.slice(5);
        return [
          { label: `Push tag ${tag}`, onClick: () => act(`Pushing ${tag}…`, `Pushed ${tag}`, () => api.tagPush(root, tag)) },
          { label: `Delete tag ${tag}…`, danger: true, onClick: async () => {
            const a = await confirm({ title: "Delete tag", body: <>Delete <span className="font-mono">{tag}</span> here? It stays on the remote if it was pushed. It's on <span className="font-mono">{entry.id.slice(0, 7)}</span> if you need it again.</>, action: "Delete tag", danger: true });
            if (a.ok) await act(`Deleting ${tag}…`, `Deleted ${tag}`, () => api.tagDelete(root, tag));
          } },
        ];
      }),
      { label: "Tag…", onClick: async () => {
        const a = await confirm({ title: "Tag commit", body: <><span className="font-mono">{entry.id.slice(0, 7)}</span> {entry.summary}</>, action: "Create tag", input: { label: "Tag name", placeholder: "v1.0.0", mono: true }, checkbox: { label: "Push to origin" } });
        if (a.ok) await act("Tagging…", `Tagged ${a.value}`, () => api.tagCreate(root, a.value, entry.id, null, a.checked));
      } },
      ...rewriteItems(entry),
    ] });
  };

  // What "All changes" compares against: the repo's base, unless this is the base.
  // Compare against: your pick, else the PR's base, else origin/main (fresher than a local main).
  const head = branch ?? (worktree ? wtBranch : null);
  const pr = head ? prByBranch[head] : undefined;
  const prBase = pr?.base && pr.base !== data?.base ? `origin/${pr.base}` : null;
  const base = (head && baseFor[head]) || prBase || data?.compare_base || data?.base || null;
  const local = (b: string) => b.replace(/^origin\//, "");
  const canCompare = !!base && !!head && local(head) !== local(base);
  // Commits on this branch that can be reworded, squashed or dropped: not pushed yet.
  const [editable, setEditable] = useState<Set<string>>(new Set());
  // The ones already on the branch's upstream: changing them means a force push after.
  const [pushed, setPushed] = useState<Set<string>>(new Set());
  // ---- create pull request ------------------------------------------------------
  const [prFor, setPrFor] = useState<string | null>(null);
  /// Branches a pull request could merge into: the usual base first, then the rest on origin.
  const prBases = (name: string) => {
    const theirs = data?.branches.find((b) => b.branch.name === name)?.branch.upstream?.replace(/^origin\//, "") ?? name;
    const first = (baseFor[name] || data?.compare_base || data?.base || "main").replace(/^origin\//, "");
    const others = [data?.base, ...(data?.branches.map((b) => b.branch.upstream?.startsWith("origin/") ? b.branch.upstream.slice(7) : null) ?? []), ...(data?.remote_only.map((r) => r.short) ?? [])];
    return [...new Set([first, ...others].filter((n): n is string => !!n && n !== theirs))];
  };
  const wtB = wtRow?.branch;
  const canPrHere = !!wtB && prs !== null && !!wtB.upstream && !prByBranch[wtB.name] && wtB.name !== data?.base;
  const [msgDlg, setMsgDlg] = useState<Omit<React.ComponentProps<typeof MessageDialog>, "onClose"> | null>(null);
  useEffect(() => {
    if (!head) { setEditable(new Set()); setPushed(new Set()); return; }
    let live = true;
    api.rewriteEditable(root, head).then((ids) => { if (live) setEditable(new Set(ids ?? [])); }).catch(() => { if (live) setEditable(new Set()); });
    api.rewritePushed(root, head).then((ids) => { if (live) setPushed(new Set(ids ?? [])); }).catch(() => { if (live) setPushed(new Set()); });
    return () => { live = false; };
  }, [root, head, refsTick]);
  const [cmp, setCmp] = useState<{ key: string; mergeBase: string | null; ahead: number } | null>(null);
  const cmpKey = canCompare ? `${base}...${head}` : "";
  useEffect(() => {
    if (!canCompare) { setCmp(null); return; }
    let live = true;
    api.compare(root, base!, head!).then((c) => { if (live) setCmp({ key: cmpKey, mergeBase: c.merge_base, ahead: c.ahead }); }).catch(() => { if (live) setCmp(null); });
    return () => { live = false; };
  }, [root, cmpKey, refsTick]);
  const cmpNow = cmp?.key === cmpKey ? cmp : null;
  const pickBase = (e: React.MouseEvent) => {
    if (!head) return;
    const names = [data?.compare_base, data?.base, ...(data?.branches.map((b) => b.branch.name) ?? [])].filter((n): n is string => !!n && local(n) !== local(head));
    setMenu({ x: e.clientX, y: e.clientY, items: [...new Set(names)].map((n) => ({ label: n === base ? `${n} ✓` : n, onClick: () => setBaseFor((m) => ({ ...m, [head]: n })) })) });
  };
  const showUncommitted = !worktree && !branch && (uncommittedChoice ?? (!commit && dirtyPaths.length > 0));
  const selected = worktree ? wtCommit : commit ?? firstId;

  const shown = worktree ? null : commit ?? firstId;
  // A repository opens on its base branch, so something is always picked in
  // the sidebar. Replaced, not pushed: Back still goes to Repositories.
  useEffect(() => {
    if (!land || !data) return;
    window.location.replace(toHash(data.compare_base ? { kind: "branch", root, name: data.compare_base } : { kind: "repo", root }));
  }, [land, data, root]);
  const view = useCenterView();
  // Whose files the Files view shows: what's picked in the sidebar. With
  // nothing picked, the main worktree's folder.
  const filesTarget = useMemo<FilesTarget>(() => {
    const folder = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
    const headOf = (p: string) => data?.branches.find((b) => b.worktree?.path === p)?.worktree?.head ?? data?.detached.find((d) => d.worktree.path === p)?.worktree.head ?? null;
    if (worktree) return { worktree, rev: null, head: headOf(worktree), label: `in ${folder(worktree)}, as they are on disk` };
    if (branch) return { worktree: null, rev: branch, label: `in ${branch}, as of its last commit` };
    if (commit) return { worktree: null, rev: commit, label: `as of commit ${commit.slice(0, 7)}` };
    return { worktree: root, rev: null, head: headOf(root), label: `in ${folder(root)} (the main worktree), as they are on disk` };
  }, [root, worktree, branch, commit, data]);
  if (!data && loadError) return <ErrorState title="Couldn't open this repository" error={loadError} onRetry={refresh} />;
  if (!data) return <Loading />;
  return (
    <div ref={side.box} className="flex min-h-0 min-w-0 grow">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {msgDlg && <MessageDialog {...msgDlg} onClose={() => setMsgDlg(null)} />}
      {prFor && (
        <PullRequestDialog
          root={root}
          branch={prFor}
          base={prBases(prFor)[0]}
          bases={prBases(prFor)}
          onClose={() => setPrFor(null)}
          onCreated={(url) => { toastDone(`Created a pull request for ${prFor}`, undefined, url ? { label: "Open on GitHub", run: () => openUrl(url).catch(toastError) } : undefined); reloadPrs(); refresh(); }}
        />
      )}
      <div style={{ width: side.size }} className="flex shrink-0 flex-col">
        <RepoSidebar root={root} data={data} current={worktree} currentBranch={branch} onOpenBranch={(name) => navigate({ kind: "branch", root, name })} onOpenRepo={() => navigate({ kind: "repo", root })} onRefresh={refresh} onOpenWorktree={(path) => navigate({ kind: "worktree", root, path })} onCreatePr={setPrFor} refreshKey={refsTick} prs={prs} prByBranch={prByBranch} overlaps={overlaps} />
      </div>
      <SplitHandle axis="x" onMouseDown={side.start} handleRef={side.handle} />
    <div ref={split.box} className="flex min-h-0 min-w-0 grow flex-col">
      {loadError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-body text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <span className="selectable min-w-0 grow truncate">Couldn't refresh: {errorParts(loadError).message}</span>
          <button onClick={refresh} className="underline">Retry</button>
        </div>
      )}
      {view === "files" ? <FilesPage root={root} target={filesTarget} tick={tick} onOpenCommit={(id) => { setCenterView("commits"); navigate({ kind: "commit", root, id }); }} /> : <>
      <div style={{ height: split.size, flex: "0 0 auto" }} className="flex min-h-0 flex-col">
        <CommitLog
          root={root}
          scope={worktree ? wtBranch : branch ?? ""}
          dirtyWorktrees={branch ? 0 : worktree ? (wtDirty > 0 ? 1 : 0) : dirty}
          uncommittedLabel={worktree ? `${wtDirty} in this worktree` : undefined}
          selected={branch ? (canCompare && brCompare ? null : brCommit ?? brFirst) : worktree ? (wtCompare ? null : selected) : showUncommitted ? null : selected}
          uncommittedSelected={!worktree && showUncommitted}
          compare={canCompare ? { base: local(base!), ahead: cmpNow?.ahead ?? null } : undefined}
          range={canCompare && cmpNow ? { own: `${base}..${head}`, rest: cmpNow.mergeBase, restLabel: `Earlier history on ${local(base!)}` } : undefined}
          compareSelected={canCompare && (branch ? brCompare : wtCompare)}
          picked={picked}
          spanEnd={span?.other}
          onSpan={pickSpan}
          onCompare={() => { pickSpan(null); if (branch) setBrCompare(true); else { setWtCompare(true); setWtCommit(null); } }}
          onSelect={(id) => { pickSpan(null); setShowUncommitted(false); setBrCompare(false); setWtCompare(false); if (branch) setBrCommit(id); else if (worktree) setWtCommit(id); else navigate(id ? { kind: "commit", root, id } : { kind: "repo", root }); }}
          onLoaded={branch ? onBranchLoaded : worktree ? undefined : onLoaded}
          onUncommitted={() => { pickSpan(null); if (worktree) { setWtCommit(null); setWtCompare(false); } else setShowUncommitted(true); }}
          onCommitMenu={commitMenu}
          branchDots={branchDots}
          prByBranch={prByBranch}
          detachedDots={detachedDots}
          heads={heads}
          refreshKey={refsTick}
        />
      </div>
      <SplitHandle axis="y" onMouseDown={split.start} handleRef={split.handle} />
      <div className="flex min-h-0 min-w-0 grow">
        {fileView ? (
          <FileView root={root} target={fileView} onMode={(mode) => setFileView({ ...fileView, mode })} onBack={() => setFileView(null)} onOpenCommit={showCommit} />
        ) : span ? (
          <CommitDetail key={`span-${span.older}-${span.newer}`} root={root} span={span} onRange={setSpanIds} onBack={() => pickSpan(null)} onFileMenu={fileMenu(span.newer, null)} />
        ) : branch ? (
          canCompare && brCompare ? <CommitDetail key={`cmp-${head}`} root={root} compare={{ base: base!, head: head! }} onPickBase={pickBase} onFileMenu={fileMenu(head!, null)} />
          : brCommit ?? brFirst ? <CommitDetail root={root} id={(brCommit ?? brFirst)!} onFileMenu={fileMenu((brCommit ?? brFirst)!, null)} /> : <Loading />
        ) : worktree ? (
          canCompare && wtCompare ? (
            <CommitDetail key={`cmp-${head}`} root={root} compare={{ base: base!, head: head! }} onPickBase={pickBase} onBack={() => setWtCompare(false)} onFileMenu={fileMenu(head!, null)} />
          ) : wtCommit ? (
            <CommitDetail root={root} id={wtCommit} onBack={() => setWtCommit(null)} onFileMenu={fileMenu(wtCommit, null)} />
          ) : (
            <Detail root={root} path={worktree} onBack={() => navigate({ kind: "repo", root })} onChanged={refresh} onCreatePr={canPrHere ? () => setPrFor(wtB!.name) : undefined} onFileMenu={fileMenu(null, worktree)} />
          )
        ) : showUncommitted && dirtyPaths.length > 0 ? (
          <UncommittedPanel root={root} worktrees={dirtyPaths} refreshKey={tick} />
        ) : shown ? (
          <CommitDetail root={root} id={shown} onFileMenu={fileMenu(shown, null)} />
        ) : (
          <div className="flex grow items-center justify-center text-body text-stone-500">No commits yet.</div>
        )}
      </div>
      </>}
    </div>
    </div>
  );
}
