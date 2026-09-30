import { useEffect, useState } from "react";
import { ago, api, changed, type BranchRow, type DetachedRow, type Overview as OverviewData, type Backup, type PullRequest, type RemoteBranch, type Stash, type Summary, type Worktree } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { MoreButton } from "../ui/MoreButton";
import { navigate } from "../lib/routes";
import { openTerminal, reveal, REVEAL_LABEL, useTerminalName } from "../lib/reveal";
import { openUrl } from "@tauri-apps/plugin-opener";
import { prBranch } from "../lib/prs";
import { ChecksMark, PrBadge } from "../ui/PrBadge";
import { NewWindowIcon } from "../ui/icons";
import { MergeDialog } from "../dialogs/MergeDialog";
import { NewBranchDialog } from "../dialogs/NewBranchDialog";
import { confirm } from "../ui/Confirm";
import { toastError, withToast } from "../ui/Toast";
import { dot, worktreeOptions } from "../lib/worktrees";
import type { Overlap } from "../lib/api";

type Props = { root: string; data: OverviewData | null; current?: string | null; currentBranch?: string | null; onOpenBranch: (name: string) => void; onOpenRepo: () => void; onRefresh: () => Promise<void>; onOpenWorktree: (path: string) => void; prs?: PullRequest[] | null; prByBranch?: Record<string, PullRequest>; overlaps?: Overlap[] };

const small = "h-6 rounded border border-stone-300 bg-white px-1.5 text-label hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const iconBtn = "inline-flex h-6 items-center rounded px-1 text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100";

type WtRow = { key: string; label: string; worktree: Worktree; status: Summary | null; branch: BranchRow | null; isMain: boolean; ahead: number | null; stale: boolean; time: number | null };

export function RepoSidebar({ root, data, current = null, currentBranch = null, onOpenBranch, onOpenRepo, onRefresh: refresh, onOpenWorktree, prs = null, prByBranch = {}, overlaps = [] }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ branch?: string; remote?: string } | null>(null);
  const [merging, setMerging] = useState<BranchRow | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return { ...DEFAULT_OPEN, ...JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") }; } catch { return DEFAULT_OPEN; }
  });
  const toggle = (k: string) => setOpen((o) => {
    const n = { ...o, [k]: !o[k] };
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });
  const [remoteQuery, setRemoteQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [stashes, setStashes] = useState<Stash[]>([]);

  useEffect(() => { api.stashList(root).then(setStashes).catch(() => setStashes([])); }, [root, data]);
  const term = useTerminalName();
  const [backups, setBackups] = useState<Backup[]>([]);
  useEffect(() => { api.backupsList(root).then((b) => setBackups(b ?? [])).catch(() => setBackups([])); }, [root, data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating({}); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /// Run a git action with feedback: "Pushing…" while it runs, then "Pushed" or the error.
  async function run<T>(doing: string, done: string, fn: () => Promise<T>, undo?: (r: T) => (() => Promise<unknown>) | null) {
    setBusy(doing);
    try {
      await withToast(doing, done, fn, undo && ((r) => { const u = undo(r); return u ? { run: u, after: refresh } : null; }));
      await refresh();
    }
    finally { setBusy(null); }
  }

  async function removeWorktree(row: WtRow) {
    // Right after the page opens, change counts may not be in yet: ask for this one.
    const n = row.status ? changed(row.status) : await api.detail(root, row.worktree.path).then((d) => d.files.length).catch(() => 0);
    const body = n > 0
      ? <><span className="font-mono">{row.label}</span> has {n} uncommitted {n === 1 ? "change" : "changes"}. They're saved first, so you can undo this. The branch is kept.</>
      : <>Remove the folder for <span className="font-mono">{row.label}</span>? The branch is kept.</>;
    if (!(await confirm({ title: "Remove worktree", body, action: "Remove worktree", danger: true })).ok) return;
    await run("Removing worktree…", `Removed worktree ${row.label}`, () => api.worktreeRemove(root, row.worktree.path, n > 0), (removed) => () => api.worktreeUndoRemove(root, removed));
  }

  async function deleteBranch(r: BranchRow) {
    const b = r.branch;
    const unpushed = !b.upstream || (b.ahead ?? 0) > 0;
    const body = unpushed
      ? <><span className="font-mono">{b.name}</span> has commits that aren't on origin. Pando keeps a backup so it can be recovered.</>
      : <>Delete <span className="font-mono">{b.name}</span>? Pando keeps a backup so it can be recovered.</>;
    const answer = await confirm({ title: "Delete branch", body, action: "Delete branch", danger: true, checkbox: b.upstream ? { label: `Also delete ${b.upstream}` } : undefined });
    if (!answer.ok) return;
    // Undo brings the local branch back; a deleted remote branch stays deleted.
    await run(`Deleting ${b.name}…`, `Deleted ${b.name}`, () => api.branchDelete(root, b.name, answer.checked), () => () => api.backupRestoreBranch(root, `refs/pando/backup/${b.name}`));
  }
  const openWin = (path: string) => openInNewWindow({ kind: "worktree", root, path }).catch(toastError);
  const openRow = (e: React.MouseEvent, path: string) => (wantsNewWindow(e) ? openWin(path) : onOpenWorktree(path));
  const show = (e: React.MouseEvent, items: MenuItem[]) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items }); };
  const sep: MenuItem = { divider: true };

  const mainWt = data?.branches.find((b) => b.is_main_worktree)?.worktree ?? data?.detached.find((d) => d.is_main_worktree)?.worktree ?? null;

  async function switchMain(name: string) {
    await run(`Switching to ${name}…`, `Switched main worktree to ${name}`, () => api.branchSwitch(root, name));
  }
  async function switchMainPicker() {
    const free = data?.branches.filter((b) => !b.worktree).map((b) => ({ value: b.branch.name, label: b.branch.name })) ?? [];
    if (free.length === 0) { toastError("Every local branch already has a worktree."); return; }
    const a = await confirm({ title: "Switch branch", body: "Check out another branch in the main worktree. Uncommitted changes must be committed or stashed first.", action: "Switch branch", select: { label: "Branch", options: free } });
    if (a.ok) await switchMain(a.choice);
  }
  async function createHere(row: WtRow) {
    const a = await confirm({ title: "Create branch", body: <>Create a branch at <span className="font-mono">{row.worktree.head?.slice(0, 7)}</span> and switch this worktree to it.</>, action: "Create branch", input: { label: "Branch name", placeholder: "feat/my-change", mono: true } });
    if (a.ok) await run("Creating branch…", `Created ${a.value}`, () => api.branchCreateAndSwitch(row.worktree.path, a.value));
  }
  async function rename(old: string) {
    const a = await confirm({ title: "Rename branch", body: <>Rename <span className="font-mono">{old}</span>. A backup of the old name is kept.</>, action: "Rename", input: { label: "New name", value: old, mono: true } });
    if (a.ok && a.value !== old) await run("Renaming…", `Renamed to ${a.value}`, () => api.branchRename(root, old, a.value), () => () => api.branchRename(root, a.value, old));
  }
  async function setUpstream(name: string, current: string | null) {
    const a = await confirm({ title: "Set upstream", body: <>The remote branch <span className="font-mono">{name}</span> pulls from and pushes to.</>, action: "Set upstream", input: { label: "Upstream", value: current ?? `origin/${name}`, mono: true } });
    if (a.ok) await run("Setting upstream…", `Upstream set to ${a.value}`, () => api.branchSetUpstream(root, name, a.value));
  }
  async function moveWorktree(row: WtRow) {
    const a = await confirm({ title: "Move worktree", body: <>Move the folder for <span className="font-mono">{row.label}</span>.</>, action: "Move", input: { label: "New location", value: row.worktree.path, mono: true } });
    if (a.ok && a.value !== row.worktree.path) await run("Moving worktree…", "Moved worktree", () => api.worktreeMove(root, row.worktree.path, a.value));
  }
  async function stashChanges(row: WtRow) {
    const a = await confirm({ title: "Stash changes", body: <>Put aside the uncommitted changes in <span className="font-mono">{row.label}</span>, including new files.</>, action: "Stash", input: { label: "Message", value: `WIP on ${row.label}` } });
    if (a.ok) await run("Stashing…", "Stashed", () => api.stashSave(row.worktree.path, a.value));
  }
  async function applyStash(st: Stash, pop: boolean) {
    const opts = worktreeOptions(data);
    const match = opts.find((o) => o.label.startsWith(st.branch ?? "\u0000"))?.value;
    const a = await confirm({ title: pop ? "Pop stash" : "Apply stash", body: <>{st.message}{pop ? ". It's removed from the list afterwards." : "."}</>, action: pop ? "Pop" : "Apply", select: { label: "Into worktree", options: opts, value: match ?? mainWt?.path } });
    if (a.ok) await run(pop ? "Popping stash…" : "Applying stash…", pop ? "Popped stash" : "Applied stash", () => api.stashApply(a.choice, st.index, pop));
  }
  async function dropStash(st: Stash) {
    if ((await confirm({ title: "Drop stash", body: <>Drop <span className="italic">{st.message}</span>? You can undo this.</>, action: "Drop stash", danger: true })).ok) {
      await run("Dropping stash…", "Dropped stash", () => api.stashDrop(root, st.index), (kept) => () => api.stashRestore(root, kept, st.message));
    }
  }
  async function deleteRemote(r: RemoteBranch) {
    if ((await confirm({ title: "Delete remote branch", body: <>Delete <span className="font-mono">{r.name}</span> on the remote? Anyone else using it loses it too.</>, action: "Delete on origin", danger: true })).ok) await run(`Deleting ${r.name}…`, `Deleted ${r.name}`, () => api.branchDeleteRemote(root, r.short));
  }

  const rowMenu = (e: React.MouseEvent, row: WtRow) => {
    const b = row.branch?.branch;
    const items: MenuItem[] = [
      { label: "Open in new window", onClick: () => openWin(row.worktree.path) },
      { label: "Copy path", onClick: () => navigator.clipboard.writeText(row.worktree.path) },
      { label: REVEAL_LABEL, onClick: () => reveal(row.worktree.path).catch(toastError) },
      ...(term ? [{ label: `Open in ${term}`, onClick: () => openTerminal(row.worktree.path) }] : []),
      sep,
    ];
    if (b?.upstream) items.push({ label: "Pull", onClick: () => run(`Pulling ${b.name}…`, `Pulled ${b.name}`, () => api.branchPull(row.worktree.path)) });
    if (b) items.push({ label: b.upstream ? "Push" : "Push to origin", onClick: () => run(`Pushing ${b.name}…`, `Pushed ${b.name}`, () => api.branchPush(root, b.name)) });
    if (!row.isMain && row.branch) items.push({ label: "Merge…", onClick: () => setMerging(row.branch!) });
    if (changed(row.status) > 0) items.push({ label: "Stash changes…", onClick: () => stashChanges(row) });
    items.push(sep);
    if (!b) items.push({ label: "Create branch here…", onClick: () => createHere(row) });
    if (row.isMain) items.push({ label: "Switch branch…", onClick: () => switchMainPicker() });
    if (b) items.push({ label: "Rename branch…", onClick: () => rename(b.name) });
    if (b) items.push({ label: "Set upstream…", onClick: () => setUpstream(b.name, b.upstream) });
    if (!row.isMain) {
      items.push({ label: "Move…", onClick: () => moveWorktree(row) });
      items.push({ label: row.worktree.locked != null ? "Unlock" : "Lock", onClick: () => run(row.worktree.locked != null ? "Unlocking…" : "Locking…", row.worktree.locked != null ? "Unlocked" : "Locked", () => api.worktreeLock(root, row.worktree.path, row.worktree.locked == null)) });
      items.push(sep);
      if (row.worktree.prunable) items.push({ label: "Prune missing folders", onClick: () => run("Pruning…", "Pruned missing folders", () => api.worktreePrune(root)) });
      items.push({ label: "Remove worktree…", onClick: () => removeWorktree(row), danger: true });
    }
    show(e, items);
  };
  const branchMenu = (e: React.MouseEvent, r: BranchRow) => show(e, [
    { label: "Open in new window", onClick: () => openInNewWindow({ kind: "branch", root, name: r.branch.name }) },
    sep,
    { label: "Add worktree…", onClick: () => setCreating({ branch: r.branch.name }) },
    { label: "Merge…", onClick: () => setMerging(r) },
    { label: "Switch main worktree to this branch", onClick: () => switchMain(r.branch.name) },
    { label: r.branch.upstream ? "Push" : "Push to origin", onClick: () => run(`Pushing ${r.branch.name}…`, `Pushed ${r.branch.name}`, () => api.branchPush(root, r.branch.name)) },
    sep,
    { label: "Rename…", onClick: () => rename(r.branch.name) },
    { label: "Set upstream…", onClick: () => setUpstream(r.branch.name, r.branch.upstream) },
    sep,
    { label: "Delete branch…", onClick: () => deleteBranch(r), danger: true },
  ]);
  const remoteMenu = (e: React.MouseEvent, r: RemoteBranch) => show(e, [
    { label: "Open in new window", onClick: () => openInNewWindow({ kind: "branch", root, name: r.name }) },
    sep,
    { label: "Add worktree…", onClick: () => setCreating({ branch: r.short, remote: r.name }) },
    sep,
    { label: "Delete on origin…", onClick: () => deleteRemote(r), danger: true },
  ]);
  // ---- backups -----------------------------------------------------------------
  const backupTitle = (b: Backup) => BACKUP_TITLE[b.kind] ?? "Backup";
  async function restoreBackup(b: Backup) {
    if (b.kind === "branch") {
      const what = b.branch_exists
        ? <>Point <span className="font-mono">{b.branch}</span> back to <span className="font-mono">{b.id.slice(0, 7)}</span>? Its current tip is backed up first, so you can undo this.</>
        : <>Bring back <span className="font-mono">{b.branch}</span> at <span className="font-mono">{b.id.slice(0, 7)}</span>.</>;
      if (!(await confirm({ title: "Restore branch", body: what, action: "Restore branch" })).ok) return;
      await run("Restoring…", `Restored ${b.branch}`, () => api.backupRestoreBranch(root, b.refname));
      return;
    }
    const shown = b.files.slice(0, 5).join(", ") + (b.files.length > 5 ? ` and ${b.files.length - 5} more` : "");
    const a = await confirm({
      title: "Restore files",
      body: <>Put back <span className="font-mono">{shown || "the saved changes"}</span>. Whatever those files hold now is backed up first.</>,
      action: "Restore files",
      select: { label: "Into worktree", options: worktreeOptions(data), value: mainWt?.path },
    });
    if (a.ok) await run("Restoring…", "Restored files", () => api.backupRestoreFiles(root, b.refname, a.choice));
  }
  const backupMenu = (e: React.MouseEvent, b: Backup) => show(e, [
    { label: b.kind === "branch" ? "Restore branch…" : "Restore files…", onClick: () => restoreBackup(b) },
    { label: "Show commit", onClick: () => navigate({ kind: "commit", root, id: b.id }) },
    sep,
    { label: "Delete backup…", danger: true, onClick: async () => {
      if ((await confirm({ title: "Delete backup", body: `Delete this backup for good? ${backupTitle(b)} can't be restored afterwards.`, action: "Delete backup", danger: true })).ok) {
        await run("Deleting…", "Deleted backup", () => api.backupDelete(root, b.refname));
      }
    } },
  ]);

  // ---- pull requests -------------------------------------------------------------
  async function addPrWorktree(pr: PullRequest) {
    setBusy("pr");
    try {
      const made = await withToast(`Adding a worktree for #${pr.number}…`, `Added a worktree for #${pr.number}`, () => api.prAddWorktree(root, pr));
      await refresh();
      if (made) onOpenWorktree(made.worktree.path);
    } finally { setBusy(null); }
  }
  const prMenu = (e: React.MouseEvent, pr: PullRequest, wtPath?: string) => show(e, [
    ...(wtPath
      ? [{ label: "Open in new window", onClick: () => openWin(wtPath) }]
      : [{ label: "Add worktree", onClick: () => addPrWorktree(pr) }]),
    sep,
    { label: "Open on GitHub", onClick: () => openUrl(pr.url).catch(toastError) },
    { label: "Copy link", onClick: () => navigator.clipboard.writeText(pr.url) },
  ]);

  const stashMenu = (e: React.MouseEvent, st: Stash) => show(e, [
    { label: "Apply…", onClick: () => applyStash(st, false) },
    { label: "Pop…", onClick: () => applyStash(st, true) },
    sep,
    { label: "Drop…", onClick: () => dropStash(st), danger: true },
  ]);

  const rows: WtRow[] = [];
  const labelFor = (path: string) => rows.find((w) => w.worktree.path === path)?.label ?? path.split(/[/\\]/).pop() ?? path;
  for (const d of data?.detached ?? []) if (d.is_main_worktree) rows.push(detachedRow(d));
  for (const b of data?.branches ?? []) if (b.worktree) rows.push({ key: b.branch.name, label: b.branch.name, worktree: b.worktree, status: b.status, branch: b, isMain: b.is_main_worktree, ahead: b.ahead_of_base, stale: b.stale, time: b.branch.last_commit?.time ?? null });
  for (const d of data?.detached ?? []) if (!d.is_main_worktree) rows.push(detachedRow(d));

  const without = data?.branches.filter((r) => !r.worktree) ?? [];
  const remote = data?.remote_only ?? [];
  const q = remoteQuery.trim().toLowerCase();
  const remoteShown = q ? remote.filter((r) => r.name.toLowerCase().includes(q)) : remote.slice(0, 8);

  const head = (key: string, title: string, count: string) => (
    <button onClick={() => toggle(key)} className="mt-2 flex items-baseline gap-2 border-t border-stone-200 px-3 pb-1 pt-2.5 text-left dark:border-stone-700">
      <span className="w-2.5 text-label text-stone-400">{open[key] ? "▾" : "▸"}</span>
      <span className="text-label font-semibold tracking-wider text-stone-500">{title}</span>
      <span className="truncate text-label text-stone-400">{count}</span>
    </button>
  );

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto bg-stone-50 text-body dark:bg-stone-900">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {creating && data && (
        <NewBranchDialog root={root} base={data.base} initialBranch={creating.branch ?? null} remote={creating.remote ?? null} onClose={() => setCreating(null)} onCreated={refresh} />
      )}
      {merging && (
        <MergeDialog root={root} path={merging.worktree?.path ?? null} branch={merging.branch.name} headSummary={merging.branch.last_commit?.summary ?? null} onClose={() => setMerging(null)} onMerged={refresh} />
      )}

      <div className="flex flex-col gap-1 border-b border-stone-200 px-3 pb-1.5 pt-2 dark:border-stone-700">
        <div className="flex items-center gap-1.5">
          <button onClick={() => setCreating({})} className="h-7 grow rounded-md bg-teal-700 px-2.5 text-body font-medium text-white hover:bg-teal-800">New branch<span className="ml-1.5 opacity-70">⌘N</span></button>
          <button onClick={() => run("Fetching…", "Fetched", () => api.fetchAll(root))} disabled={!!busy} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-body hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700">{busy === "Fetching…" ? "Fetching…" : "Fetch"}</button>
        </div>
        <span className="self-end text-label text-stone-500" title={data?.fetched_at ? new Date(data.fetched_at * 1000).toLocaleString() : undefined}>
          {busy === "Fetching…" ? "Fetching…" : data?.fetched_at ? `Fetched ${ago(data.fetched_at)}` : data ? "Not fetched yet" : ""}
        </span>
      </div>

      <button onClick={onOpenRepo} className={`my-1 flex items-center gap-2 px-3 py-1.5 text-left ${current === null && currentBranch === null ? "bg-teal-50 font-medium dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
        <span className="h-2 w-2 shrink-0 rounded-full border-2 border-stone-400" />
        <span className="grow text-body">All branches</span>
        {data && (() => {
          const n = data.branches.reduce((t, b) => t + changed(b.status), 0) + data.detached.reduce((t, d) => t + changed(d.status), 0);
          return n > 0 ? <span className="text-label text-amber-700">{n} uncommitted</span> : null;
        })()}
      </button>

      {head("worktrees", "WORKTREES", data ? String(rows.length) : "…")}
      {open.worktrees && rows.map((r) => {
        const n = changed(r.status);
        const conflicts = r.status?.conflicts ?? 0;
        const pending = !data?.status_loaded && !r.worktree.prunable;
        const { cls: dotCls, tip: dotTip } = dot({ status: r.status, missing: !!r.worktree.prunable, isMain: r.isMain, loaded: !!data?.status_loaded });
        return (
          <div key={r.key} onClick={(e) => openRow(e, r.worktree.path)} onContextMenu={(e) => rowMenu(e, r)} title={r.worktree.path} className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${current === r.worktree.path ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
            <span title={dotTip} className={`h-2 w-2 shrink-0 rounded-full ${dotCls}`} />
            <div className="min-w-0 grow">
              <div className="flex items-center gap-1.5"><span className="truncate font-mono text-body font-medium">{r.label}</span>{prByBranch[r.label] && <PrBadge pr={prByBranch[r.label]} />}<OverlapMark path={r.worktree.path} overlaps={overlaps} labelFor={labelFor} /></div>
              <div className="truncate text-label text-stone-500">
                {r.isMain ? "main worktree" : null}
                {r.isMain && (n > 0 || r.ahead) ? " · " : ""}
                {pending ? "checking…" : r.worktree.prunable ? "folder missing" : conflicts ? `${conflicts} conflicts` : n > 0 ? `${n} changed` : r.isMain ? "" : "clean"}
                {!r.isMain && r.branch?.merged ? <> · <span className="text-teal-700" title={`Everything on this branch is in ${data?.base ?? "the base"}`}>merged</span></> : !r.isMain && r.ahead ? ` · ${r.ahead} ahead` : ""}
                <SyncCounts b={r.branch?.branch} />
                {r.stale ? " · stale" : ""}
                {r.time ? ` · ${ago(r.time)}` : ""}
              </div>
            </div>
            <div className="hidden shrink-0 items-center gap-1 group-hover:flex" onClick={(e) => e.stopPropagation()}>
              {!r.isMain && r.branch && (r.branch.merged
                ? <button onClick={() => removeWorktree(r)} disabled={!!busy} className={small}>Remove worktree</button>
                : <button onClick={() => setMerging(r.branch)} disabled={!!busy} className={`${small} border-teal-700 text-teal-700`}>Merge</button>)}
              <button onClick={() => openWin(r.worktree.path)} title="Open in new window" aria-label={`Open ${r.label} in new window`} className={iconBtn}><NewWindowIcon /></button>
            </div>
            <MoreButton onOpen={(e) => rowMenu(e, r)} label={`Actions for ${r.label}`} />
          </div>
        );
      })}

      {head("branches", "BRANCHES", data ? `${without.length} without a worktree` : "")}
      {open.branches && without.map((r) => (
        <div key={r.branch.name} onClick={(e) => (wantsNewWindow(e) ? openInNewWindow({ kind: "branch", root, name: r.branch.name }) : onOpenBranch(r.branch.name))} onContextMenu={(e) => branchMenu(e, r)} title={r.branch.last_commit?.summary} className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${currentBranch === r.branch.name ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
          <div className="min-w-0 grow">
            <div className="flex items-center gap-1.5"><span className="truncate font-mono text-body">{r.branch.name}</span>{prByBranch[r.branch.name] && <PrBadge pr={prByBranch[r.branch.name]} />}</div>
            <div className="truncate text-label text-stone-500">{r.ahead_of_base ? `${r.ahead_of_base} ahead` : "0 ahead"}<SyncCounts b={r.branch} />{r.branch.last_commit ? ` · ${ago(r.branch.last_commit.time)}` : ""}</div>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setCreating({ branch: r.branch.name }); }} disabled={!!busy} className={`${small} hidden group-hover:block`}>Add worktree</button>
          <MoreButton onOpen={(e) => branchMenu(e, r)} label={`Actions for ${r.branch.name}`} />
        </div>
      ))}
      {open.branches && data && without.length === 0 && <div className="px-3 py-1 text-label text-stone-500">Every local branch has a worktree.</div>}

      {prs && head("prs", "PULL REQUESTS", String(prs.length))}
      {prs && open.prs && prs.length === 0 && <div className="px-3 py-1 text-label text-stone-500">No open pull requests.</div>}
      {prs && open.prs && prs.map((pr) => {
        const wtRow = rows.find((w) => w.branch?.branch.name === prBranch(pr));
        const see = (e: React.MouseEvent) => {
          if (wtRow) openRow(e, wtRow.worktree.path);
          else if (!pr.from_fork) onOpenBranch(`origin/${pr.head}`);
          else openUrl(pr.url).catch(toastError);
        };
        return (
          <div key={pr.number} onClick={see} onContextMenu={(e) => prMenu(e, pr, wtRow?.worktree.path)} title={`${pr.title}\n${pr.url}`} className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
            {wtRow ? <span title="Has a worktree" className={`h-2 w-2 shrink-0 rounded-full ${dot({ status: wtRow.status, missing: !!wtRow.worktree.prunable, isMain: wtRow.isMain, loaded: !!data?.status_loaded }).cls}`} /> : null}
            <div className="min-w-0 grow">
              <div className="flex items-center gap-1.5"><span className="shrink-0 font-mono text-label text-stone-500">#{pr.number}</span><span className="truncate">{pr.title}</span></div>
              <div className="flex items-center gap-1 truncate text-label text-stone-500">
                <ChecksMark checks={pr.checks} />
                <span className="truncate">{pr.author}{pr.draft ? " · draft" : ""}{REVIEW[pr.review] ? ` · ${REVIEW[pr.review]}` : ""}{pr.from_fork ? " · from a fork" : ""}</span>
              </div>
            </div>
            {!wtRow && <button onClick={(e) => { e.stopPropagation(); addPrWorktree(pr); }} disabled={!!busy} className={`${small} hidden group-hover:block`}>Add worktree</button>}
            <MoreButton onOpen={(e) => prMenu(e, pr, wtRow?.worktree.path)} label={`Actions for #${pr.number}`} />
          </div>
        );
      })}

      {stashes.length > 0 && head("stashes", "STASHES", String(stashes.length))}
      {open.stashes && stashes.map((st) => (
        <div key={st.index} onContextMenu={(e) => stashMenu(e, st)} title={st.message} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
          <div className="min-w-0 grow">
            <div className="truncate">{st.message.replace(/^On [^:]+: /, "").replace(/^WIP on [^:]+: /, "")}</div>
            <div className="truncate text-label text-stone-500">{st.branch ? `from ${st.branch} · ` : ""}{ago(st.time)}</div>
          </div>
          <button onClick={() => applyStash(st, true)} disabled={!!busy} className={`${small} hidden group-hover:block`}>Pop</button>
          <MoreButton onOpen={(e) => stashMenu(e, st)} label="Stash actions" />
        </div>
      ))}

      {head("remote", "REMOTE BRANCHES", data ? String(remote.length) : "")}
      {open.remote && (
        <>
          <div className="px-3 pb-1">
            <input value={remoteQuery} onChange={(e) => setRemoteQuery(e.target.value)} placeholder="Search" className="h-6 w-full rounded border border-stone-300 bg-white px-1.5 text-label dark:border-stone-600 dark:bg-stone-700" />
          </div>
          {remoteShown.map((r: RemoteBranch) => (
            <div key={r.name} onClick={(e) => (wantsNewWindow(e) ? openInNewWindow({ kind: "branch", root, name: r.name }) : onOpenBranch(r.name))} onContextMenu={(e) => remoteMenu(e, r)} title={r.last_commit?.summary} className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${currentBranch === r.name ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
              <div className="min-w-0 grow">
                <div className="truncate font-mono text-body text-stone-600 dark:text-stone-300">{r.name}</div>
                <div className="truncate text-label text-stone-500">{r.last_commit ? `${r.last_commit.author} · ${ago(r.last_commit.time)}` : ""}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); setCreating({ branch: r.short, remote: r.name }); }} disabled={!!busy} className={`${small} hidden group-hover:block`}>Add worktree</button>
              <MoreButton onOpen={(e) => remoteMenu(e, r)} label={`Actions for ${r.name}`} />
            </div>
          ))}
          {!q && remote.length > 8 && <div className="px-3 py-1 text-label text-stone-500">Showing 8 of {remote.length}. Type to search.</div>}
          {q && remoteShown.length === 0 && <div className="px-3 py-1 text-label text-stone-500">No match.</div>}
        </>
      )}
      {backups.length > 0 && head("backups", "BACKUPS", String(backups.length))}
      {open.backups && backups.map((b) => (
        <div key={b.refname} onContextMenu={(e) => backupMenu(e, b)} title={b.files.join("\n") || b.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
          <div className="min-w-0 grow">
            <div className={`truncate ${b.kind === "branch" ? "font-mono" : ""}`}>{b.kind === "branch" ? b.branch : backupTitle(b)}</div>
            <div className="truncate text-label text-stone-500">
              {b.kind === "branch" ? (b.branch_exists ? "branch before a change" : "deleted branch") : `${b.files.length} ${b.files.length === 1 ? "file" : "files"}`} · {ago(b.time)}
            </div>
          </div>
          <button onClick={() => restoreBackup(b)} disabled={!!busy} className={`${small} hidden group-hover:block`}>Restore</button>
          <MoreButton onOpen={(e) => backupMenu(e, b)} label={`Actions for backup ${b.branch ?? backupTitle(b)}`} />
        </div>
      ))}
      <div className="h-4" />
    </aside>
  );
}

const OPEN_KEY = "pando.sidebar.open";
const DEFAULT_OPEN: Record<string, boolean> = { worktrees: true, branches: true, prs: true, stashes: true, remote: false, backups: false };
const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };
const BACKUP_TITLE: Record<string, string> = {
  discard: "Discarded changes",
  remove_worktree: "Changes in a removed worktree",
  restore: "Replaced by a restore",
  stash: "Dropped stash",
};

function detachedRow(d: DetachedRow): WtRow {
  return { key: d.worktree.path, label: `detached at ${d.worktree.head?.slice(0, 7) ?? "?"}`, worktree: d.worktree, status: d.status, branch: null, isMain: d.is_main_worktree, ahead: null, stale: false, time: null };
}

/// " · ↑2 ↓1": commits to push and to pull, against the branch's upstream.
function SyncCounts({ b }: { b?: import("../lib/api").Branch }) {
  if (!b?.upstream) return null;
  const up = b.ahead ?? 0, down = b.behind ?? 0;
  if (!up && !down) return null;
  const tip = [up && `${up} to push`, down && `${down} to pull`].filter(Boolean).join(", ") + ` (${b.upstream})`;
  return <span title={tip}>{" · "}{up ? `↑${up}` : ""}{up && down ? " " : ""}{down ? `↓${down}` : ""}</span>;
}

/// ⚠ when another worktree changes the same files; hover lists them.
function OverlapMark({ path, overlaps, labelFor }: { path: string; overlaps: Overlap[]; labelFor: (p: string) => string }) {
  const mine = overlaps.filter((o) => o.a === path || o.b === path);
  if (mine.length === 0) return null;
  const lines = mine.map((o) => {
    const other = labelFor(o.a === path ? o.b : o.a);
    const shown = o.files.slice(0, 5).join(", ") + (o.files.length > 5 ? ` and ${o.files.length - 5} more` : "");
    return `Also changed in ${other}: ${shown}`;
  });
  const count = new Set(mine.flatMap((o) => o.files)).size;
  return (
    <span title={lines.join("\n")} aria-label={`${count} ${count === 1 ? "file" : "files"} also changed in another worktree`} className="shrink-0 cursor-help text-label text-amber-700">
      ⚠ {count}
    </span>
  );
}
