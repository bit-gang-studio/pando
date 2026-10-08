import { useEffect, useRef, useState } from "react";
import { ago, api, changed, type Branch, type BranchRow, type DetachedRow, type Overview as OverviewData, type Backup, type PullRequest, type RemoteBranch, type Stash, type Summary, type Tag, type Worktree } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { BranchPicker, type PickBranch } from "../ui/BranchPicker";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { MoreButton } from "../ui/MoreButton";
import { navigate } from "../lib/routes";
import { openEditor, openTerminal, reveal, REVEAL_LABEL, useEditors, useTerminalName } from "../lib/reveal";
import { openUrl } from "@tauri-apps/plugin-opener";
import { homeDir } from "@tauri-apps/api/path";
import { prBranch } from "../lib/prs";
import { ChecksMark, PrBadge } from "../ui/PrBadge";
import { MergeDialog } from "../dialogs/MergeDialog";
import { NewBranchDialog } from "../dialogs/NewBranchDialog";
import { confirm } from "../ui/Confirm";
import { toastError, withToast } from "../ui/Toast";
import { dot, folderName, tilde, worktreeOptions } from "../lib/worktrees";
import { overlayOpen } from "../lib/keys";
import { forcePush } from "../lib/forcePush";
import type { Overlap } from "../lib/api";

type Props = { root: string; data: OverviewData | null; current?: string | null; currentBranch?: string | null; onOpenBranch: (name: string) => void; onOpenRepo: () => void; onRefresh: () => Promise<void>; onOpenWorktree: (path: string) => void; /** Open the Create pull request dialog for a branch. */ onCreatePr?: (branch: string) => void; /** Goes up when a ref moved: stashes and backups reload then. */ refreshKey?: number; prs?: PullRequest[] | null; prByBranch?: Record<string, PullRequest>; overlaps?: Overlap[] };


type WtRow = { key: string; label: string; worktree: Worktree; status: Summary | null; branch: BranchRow | null; isMain: boolean; ahead: number | null; stale: boolean; time: number | null };

export function RepoSidebar({ root, data, current = null, currentBranch = null, onOpenBranch, onOpenRepo, onRefresh: refresh, onOpenWorktree, onCreatePr, refreshKey, prs = null, prByBranch = {}, overlaps = [] }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ branch?: string; remote?: string } | null>(null);
  const [merging, setMerging] = useState<BranchRow | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return { ...DEFAULT_OPEN, ...JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") }; } catch { return DEFAULT_OPEN; }
  });
  // The order of the sections, and of the rows inside Worktrees and Branches, is the
  // user's. Remembered on this computer; the rows per repository.
  const [order, setOrderState] = useState<SectionKey[]>(loadOrder);
  const [rowOrder, setRowOrder] = useState<Record<string, string[]>>(() => { try { return JSON.parse(localStorage.getItem(`${ROWS_KEY}:${root}`) ?? "{}") as Record<string, string[]>; } catch { return {}; } });
  /// The keys showing in each list right now, in order. Filled in on every render.
  const shownKeys = useRef<Record<string, string[]>>({});
  const els = useRef<Record<string, HTMLElement | null>>({});
  const [drag, setDrag] = useState<{ list: string; key: string; over: string | null; after: boolean } | null>(null);
  const saveOrder = (list: string, next: string[]) => {
    if (list === "sections") {
      // Sections that aren't showing keep their place after the ones that are.
      const all = [...next, ...order.filter((k) => !next.includes(k))] as SectionKey[];
      setOrderState(all);
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(all)); } catch { /* not remembered, still moved */ }
    } else {
      const all = { ...rowOrder, [list]: next };
      setRowOrder(all);
      try { localStorage.setItem(`${ROWS_KEY}:${root}`, JSON.stringify(all)); } catch { /* not remembered, still moved */ }
    }
  };
  /// Move `key` to just before or after `over`, within one list.
  const place = (list: string, key: string, over: string, after: boolean) => {
    if (key === over) return;
    const rest = (shownKeys.current[list] ?? []).filter((k) => k !== key);
    rest.splice(rest.indexOf(over) + (after ? 1 : 0), 0, key);
    saveOrder(list, rest);
  };
  const nudge = (list: string, key: string, by: -1 | 1) => {
    const shown = shownKeys.current[list] ?? [];
    const to = shown[shown.indexOf(key) + by];
    if (to) place(list, key, to, by === 1);
  };
  // Dragged with the mouse, not the browser's own drag and drop: that one is taken by file drops on Windows.
  const startDrag = (e: React.MouseEvent, list: string, key: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    let at: { over: string | null; after: boolean } = { over: null, after: false };
    const move = (m: MouseEvent) => {
      at = { over: null, after: false };
      for (const k of shownKeys.current[list] ?? []) {
        const r = els.current[`${list}:${k}`]?.getBoundingClientRect();
        if (r && m.clientY >= r.top && m.clientY < r.bottom && m.clientX >= r.left && m.clientX < r.right) { at = { over: k, after: m.clientY > r.top + r.height / 2 }; break; }
      }
      setDrag({ list, key, ...at });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      if (at.over) place(list, key, at.over, at.after);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    setDrag({ list, key, over: null, after: false });
  };
  /// What a draggable thing needs: where it is, how it looks mid-drag, and its handle.
  const dragCls = (list: string, key: string) => `relative ${drag?.list === list && drag.over === key && drag.key !== key ? (drag.after ? "shadow-[inset_0_-2px_0_0_var(--color-teal-600)]" : "shadow-[inset_0_2px_0_0_var(--color-teal-600)]") : ""} ${drag?.list === list && drag.key === key ? "opacity-50" : ""}`;
  const grip = (list: string, key: string, name: string, cls: string, top: number) => (
    <button onMouseDown={(e) => startDrag(e, list, key)} onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); nudge(list, key, e.key === "ArrowUp" ? -1 : 1); } }} onClick={(e) => e.stopPropagation()} title="Drag to move this. Or focus it and press ↑ or ↓." aria-label={`Move ${name}`} style={{ top }} className={`absolute left-0 z-[1] flex h-5 w-3 cursor-grab items-center justify-center text-label leading-none text-stone-300 hover:text-stone-600 focus:opacity-100 active:cursor-grabbing dark:text-stone-600 dark:hover:text-stone-300 ${cls}`}>⋮⋮</button>
  );
  /// `items` in the user's order: the ones they've placed first, new ones after, as they came.
  const inOrder = <T,>(list: string, items: T[], keyOf: (t: T) => string): T[] => {
    const saved = rowOrder[list] ?? [];
    const at = (t: T) => { const i = saved.indexOf(keyOf(t)); return i < 0 ? Infinity : i; };
    const out = items.map((t, i) => ({ t, i })).sort((a, b) => at(a.t) - at(b.t) || a.i - b.i).map((x) => x.t);
    shownKeys.current[list] = out.map(keyOf);
    return out;
  };
  const toggle = (k: string) => setOpen((o) => {
    const n = { ...o, [k]: !o[k] };
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });
  const [remoteQuery, setRemoteQuery] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [picking, setPicking] = useState<{ x: number; y: number; row: WtRow } | null>(null);
  const [home, setHome] = useState("");
  useEffect(() => { homeDir().then((h) => { if (typeof h === "string") setHome(h); }).catch(() => {}); }, []);
  const [stashes, setStashes] = useState<Stash[]>([]);

  // With a refreshKey, reload when refs moved; without one, on every refresh as before.
  const reloadOn = refreshKey ?? data;
  useEffect(() => { api.stashList(root).then(setStashes).catch(() => setStashes([])); }, [root, reloadOn]);
  const term = useTerminalName();
  const editors = useEditors();
  const [backups, setBackups] = useState<Backup[]>([]);
  useEffect(() => { api.backupsList(root).then((b) => setBackups(b ?? [])).catch(() => setBackups([])); }, [root, reloadOn]);
  useEffect(() => { api.tagList(root).then((t) => setTags(t ?? [])).catch(() => setTags([])); }, [root, reloadOn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); if (!overlayOpen()) setCreating({}); }
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
    const folder = row.worktree.path.split(/[/\\]/).filter(Boolean).pop();
    const stays = row.worktree.branch
      ? <> The branch <span className="font-mono">{row.worktree.branch}</span> and its commits stay. You can add a worktree for it again anytime.</>
      : null;
    const body = n > 0
      ? <>Deletes the folder <span className="font-mono">{folder}</span>. Its {n} uncommitted {n === 1 ? "change is" : "changes are"} saved first, so you can undo this.{stays}</>
      : <>Deletes the folder <span className="font-mono">{folder}</span>.{stays}</>;
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
  /// Check out another branch in a worktree. Only branches with no worktree
  /// are offered: git allows a branch in one worktree at a time.
  async function switchPicker(row: WtRow) {
    const free = data?.branches.filter((b) => !b.worktree).map((b) => ({ value: b.branch.name, label: b.branch.name })) ?? [];
    if (free.length === 0) { toastError("Every local branch already has a worktree."); return; }
    const folder = row.worktree.path.split(/[/\\]/).filter(Boolean).pop();
    const now = row.worktree.branch;
    const a = await confirm({
      title: "Switch branch",
      body: <>Check out another branch in {row.isMain ? "the main worktree" : <span className="font-mono">{folder}</span>}.{now ? <> <span className="font-mono">{now}</span> stays as a branch, without a worktree.</> : null} Uncommitted changes come along if they don't clash.</>,
      action: "Switch branch",
      select: { label: "Branch", options: free },
    });
    if (a.ok) await switchTo(row, a.choice);
  }
  async function switchTo(row: WtRow, name: string) {
    const path = row.worktree.path;
    await run(`Switching to ${name}…`, `Switched ${row.isMain ? "the main worktree" : folderName(path)} to ${name}`, () => api.worktreeSwitch(root, path, name), (was) => (was ? () => api.worktreeSwitch(root, path, was) : null));
  }
  /// Every local branch, for the picker on a worktree's row. One that's in a
  /// worktree can't be picked, and says which.
  const pickable = (row: WtRow): PickBranch[] => (data?.branches ?? []).map((b) => ({
    name: b.branch.name,
    where: !b.worktree ? undefined : b.worktree.path === row.worktree.path ? "checked out here" : `in ${folderName(b.worktree.path)}`,
  }));
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
  /// A pushed branch with no open pull request, when gh can list them.
  const canPr = (b?: Branch | null): b is Branch => !!b && !!onCreatePr && prs !== null && !!b.upstream && !prByBranch[b.name] && b.name !== data?.base && !b.upstream_rewritten;
  async function force(b: Branch) {
    if (await forcePush(root, b)) await refresh();
  }
  async function repairWorktree(row: WtRow) {
    const a = await confirm({ title: "Repair worktree", body: <>Git can't find the folder for <span className="font-mono">{row.label}</span>. If you moved or renamed it, say where it is now. Nothing inside it changes.</>, action: "Repair worktree", input: { label: "Where the folder is now", value: row.worktree.path, mono: true } });
    if (a.ok) await run("Repairing worktree…", `Repaired worktree ${row.label}`, () => api.worktreeRepair(root, a.value.trim()));
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
      ...editors.map((e) => ({ label: `Open in ${e}`, onClick: () => { openEditor(e, row.worktree.path); } })),
      sep,
    ];
    if (b?.upstream_rewritten) items.push({ label: "Force push…", onClick: () => force(b) });
    else {
      if (b?.upstream) items.push({ label: "Pull", onClick: () => run(`Pulling ${b.name}…`, `Pulled ${b.name}`, () => api.branchPull(row.worktree.path)) });
      if (b) items.push({ label: b.upstream ? "Push" : "Push to origin", onClick: () => run(`Pushing ${b.name}…`, `Pushed ${b.name}`, () => api.branchPush(root, b.name)) });
    }
    if (canPr(b)) items.push({ label: "Create pull request…", onClick: () => onCreatePr!(b.name) });
    if (!row.isMain && row.branch) items.push({ label: "Merge…", onClick: () => setMerging(row.branch!) });
    if (changed(row.status) > 0) items.push({ label: "Stash changes…", onClick: () => stashChanges(row) });
    items.push(sep);
    if (!b) items.push({ label: "Create branch here…", onClick: () => createHere(row) });
    if (!row.worktree.prunable) items.push({ label: "Switch branch…", onClick: () => switchPicker(row) });
    if (b) items.push({ label: "Rename branch…", onClick: () => rename(b.name) });
    if (b) items.push({ label: "Set upstream…", onClick: () => setUpstream(b.name, b.upstream) });
    if (!row.isMain) {
      items.push({ label: "Move…", onClick: () => moveWorktree(row) });
      items.push({ label: row.worktree.locked != null ? "Unlock" : "Lock", onClick: () => run(row.worktree.locked != null ? "Unlocking…" : "Locking…", row.worktree.locked != null ? "Unlocked" : "Locked", () => api.worktreeLock(root, row.worktree.path, row.worktree.locked == null)) });
      items.push(sep);
      if (row.worktree.prunable) items.push({ label: "Repair worktree…", onClick: () => repairWorktree(row) });
      if (row.worktree.prunable) items.push({ label: "Prune missing folders", onClick: () => run("Pruning…", "Pruned missing folders", () => api.worktreePrune(root)) });
      items.push({ label: row.worktree.branch ? "Remove worktree (keep branch)…" : "Remove worktree…", onClick: () => removeWorktree(row), danger: true });
    }
    show(e, items);
  };
  const branchMenu = (e: React.MouseEvent, r: BranchRow) => show(e, [
    { label: "Open in new window", onClick: () => openInNewWindow({ kind: "branch", root, name: r.branch.name }) },
    sep,
    { label: "Add worktree…", onClick: () => setCreating({ branch: r.branch.name }) },
    { label: "Merge…", onClick: () => setMerging(r) },
    { label: "Switch main worktree to this branch", onClick: () => switchMain(r.branch.name) },
    r.branch.upstream_rewritten
      ? { label: "Force push…", onClick: () => force(r.branch) }
      : { label: r.branch.upstream ? "Push" : "Push to origin", onClick: () => run(`Pushing ${r.branch.name}…`, `Pushed ${r.branch.name}`, () => api.branchPush(root, r.branch.name)) },
    ...(canPr(r.branch) ? [{ label: "Create pull request…", onClick: () => onCreatePr!(r.branch.name) }] : []),
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
  const showTag = (t: Tag) => navigate({ kind: "commit", root, id: t.target });
  const tagMenu = (e: React.MouseEvent, t: Tag) => show(e, [
    { label: "Show commit", onClick: () => showTag(t) },
    { label: "Copy tag name", onClick: () => navigator.clipboard.writeText(t.name) },
    { label: "Push tag", onClick: () => run(`Pushing ${t.name}…`, `Pushed ${t.name}`, () => api.tagPush(root, t.name)) },
    sep,
    { label: "Delete tag…", danger: true, onClick: async () => {
      const a = await confirm({ title: "Delete tag", body: <>Delete <span className="font-mono">{t.name}</span> here? It stays on the remote if it was pushed. You can undo this.</>, action: "Delete tag", danger: true });
      if (a.ok) await run(`Deleting ${t.name}…`, `Deleted tag ${t.name}`, () => api.tagDelete(root, t.name), () => () => api.tagRestore(root, t.name, t.object));
    } },
  ]);
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

  // What branches are compared to: origin/<default> when there's a remote, else the local default branch.
  const base = data?.compare_base ?? data?.base ?? "the base";
  // A base that isn't one of the local branches is a remote one: "origin/main".
  const remoteBase = !!data?.compare_base && !data.branches.some((b) => b.branch.name === data.compare_base);
  /// The local branch that goes with the base: "main" for "origin/main".
  const baseLocal = remoteBase ? base.split("/").slice(1).join("/") : base;
  const hasRemote = remoteBase || (data?.remote_only.length ?? 0) > 0 || !!data?.branches.some((b) => b.branch.upstream);
  const rows: WtRow[] = [];
  const labelFor = (path: string) => rows.find((w) => w.worktree.path === path)?.label ?? path.split(/[/\\]/).pop() ?? path;
  for (const d of data?.detached ?? []) if (d.is_main_worktree) rows.push(detachedRow(d));
  for (const b of data?.branches ?? []) if (b.worktree) rows.push({ key: b.branch.name, label: b.branch.name, worktree: b.worktree, status: b.status, branch: b, isMain: b.is_main_worktree, ahead: b.ahead_of_base, stale: b.stale, time: b.branch.last_commit?.time ?? null });
  for (const d of data?.detached ?? []) if (!d.is_main_worktree) rows.push(detachedRow(d));

  const without = inOrder("branches", data?.branches.filter((r) => !r.worktree) ?? [], (r) => r.branch.name);
  const wtRows = inOrder("worktrees", rows, (r) => r.worktree.path);
  const remote = data?.remote_only ?? [];
  const q = remoteQuery.trim().toLowerCase();
  const remoteShown = q ? remote.filter((r) => r.name.toLowerCase().includes(q)) : remote.slice(0, 8);

  const tq = tagQuery.trim().toLowerCase();
  const tagsShown = tq ? tags.filter((t) => t.name.toLowerCase().includes(tq)).slice(0, 50) : tags.slice(0, 8);

  const head = (key: string, title: string, count: string) => (
    <button onClick={() => toggle(key)} className="mt-2 flex w-full items-baseline gap-2 border-t border-stone-200 px-3 pb-1 pt-2.5 text-left dark:border-stone-700">
      <span className="w-2.5 text-label text-stone-400">{open[key] ? "▾" : "▸"}</span>
      <span className="text-label font-semibold tracking-wider text-stone-500">{title}</span>
      <span className="truncate text-label text-stone-400">{count}</span>
    </button>
  );

  // Each section, by key. The order they show in is the user's: see `order`.
  const parts: Record<SectionKey, React.ReactNode> = {
    all: true ? (<>
          <button onClick={onOpenRepo} className={`mt-1 flex w-full items-start gap-2 whitespace-normal! border-t border-stone-200 px-3 py-2 text-left dark:border-stone-700 ${current === null && currentBranch === null ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border-2 border-stone-400" />
            <span className="min-w-0 grow">
              <span className="block text-body font-medium">All branches</span>
              <span className="block text-label font-normal text-stone-500">every branch in this repository, checked out or not, local and remote</span>
            </span>
          </button>
    </>) : null,
    base: !!data?.compare_base ? (<>
          {data?.compare_base && (
            <section aria-label="Base">
              {head("base", "BASE", open.base ? "" : base)}
              {open.base && <button onClick={(e) => (wantsNewWindow(e) ? openInNewWindow({ kind: "branch", root, name: base }) : onOpenBranch(base))} title={`Show ${base}'s commits`} className={`block w-full whitespace-normal! px-3 py-1.5 pl-[30px] text-left ${currentBranch === base ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
                <span className="block truncate font-mono text-body font-medium">{base}</span>
                <span className="block text-label text-stone-500">
                  {remoteBase
                    ? <>The remote's <span className="font-mono">{baseLocal}</span>, as of your last fetch. Every branch here is compared to it.</>
                    : <>Your local <span className="font-mono">{base}</span> branch. There's no remote copy of it, so every branch here is compared to it.</>}
                </span>
              </button>}
            </section>
          )}
    </>) : null,
    worktrees: true ? (<>
          {head("worktrees", "WORKTREES", data ? String(rows.length) : "…")}
          {open.worktrees && wtRows.map((r) => {
            const n = changed(r.status);
            const conflicts = r.status?.conflicts ?? 0;
            const pending = !data?.status_loaded && !r.worktree.prunable;
            const { cls: dotCls, tip: dotTip } = dot({ status: r.status, missing: !!r.worktree.prunable, isMain: r.isMain, loaded: !!data?.status_loaded });
            return (
              <div key={r.key} ref={(el) => { els.current[`worktrees:${r.worktree.path}`] = el; }} onClick={(e) => openRow(e, r.worktree.path)} onContextMenu={(e) => rowMenu(e, r)} title={r.worktree.path} className={`group flex cursor-pointer items-start gap-2 px-3 py-1.5 ${dragCls("worktrees", r.worktree.path)} ${current === r.worktree.path ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
                {grip("worktrees", r.worktree.path, folderName(r.worktree.path), "opacity-0 group-hover:opacity-100", 6)}
                <span title={dotTip} className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotCls}`} />
                <div className="min-w-0 grow">
                  <div className="flex items-center gap-1.5"><span className="truncate font-mono text-body font-medium">{folderName(r.worktree.path)}</span>{r.isMain && <span title={MAIN_WORKTREE} className="shrink-0 cursor-help rounded border border-stone-300 px-1 text-label text-stone-600 dark:border-stone-600 dark:text-stone-300">main worktree</span>}<OverlapMark path={r.worktree.path} overlaps={overlaps} labelFor={labelFor} /></div>
                  <div data-path className="truncate font-mono text-label text-stone-500">{tilde(r.worktree.path, home)}</div>
                  <Todo about="folder" items={[
                    pending ? { text: "checking…" } : r.worktree.prunable ? { text: "folder missing", tone: "bad" } : conflicts ? { text: count(conflicts, "file", "with conflicts"), tone: "bad", tip: "A merge or rebase stopped here. Open the worktree to resolve them." } : n > 0 ? { text: count(n, "file", "to commit"), tip: `${count(n, "file")} edited in this folder and not committed yet.` } : null,
                  ]} />
                  <div className="flex items-center gap-1.5 text-label text-stone-500">
                    {r.worktree.prunable
                      ? <span className="truncate">{r.branch ? <>on <span className="font-mono text-stone-800 dark:text-stone-100">{r.label}</span></> : <span title={NO_BRANCH}>no branch · commit <span className="font-mono">{r.worktree.head?.slice(0, 7) ?? "?"}</span> checked out</span>}</span>
                      : <button onClick={(e) => { e.stopPropagation(); const at = e.currentTarget.getBoundingClientRect(); setPicking({ x: at.left, y: at.bottom + 2, row: r }); }} disabled={!!busy} aria-haspopup="dialog" aria-label={`Switch branch in ${folderName(r.worktree.path)}`} title="Switch this worktree to another branch" className="flex min-w-0 items-center gap-1 rounded hover:text-stone-900 dark:hover:text-white">
                          <span className="truncate">{r.branch ? <>on <span className="font-mono text-stone-800 dark:text-stone-100">{r.label}</span></> : <span title={NO_BRANCH}>no branch · commit <span className="font-mono">{r.worktree.head?.slice(0, 7) ?? "?"}</span> checked out</span>}</span><span className="shrink-0 text-label text-stone-400">▾</span>
                        </button>}
                    {prByBranch[r.label] && <PrBadge pr={prByBranch[r.label]} />}
                  </div>
                  <Todo about="branch" items={r.branch ? [
                    ...syncTodo(r.branch.branch, hasRemote),
                    ...(r.branch.branch.name === baseLocal ? [] : baseTodo(r.branch, base)),
                  ] : []} />
                </div>
                <MoreButton onOpen={(e) => rowMenu(e, r)} label={`Actions for ${r.label}`} />
              </div>
            );
          })}
    </>) : null,
    branches: true ? (<>
          {head("branches", "BRANCHES", data ? `${without.length} without a worktree` : "")}
          {open.branches && without.map((r) => (
            <div key={r.branch.name} ref={(el) => { els.current[`branches:${r.branch.name}`] = el; }} onClick={(e) => (wantsNewWindow(e) ? openInNewWindow({ kind: "branch", root, name: r.branch.name }) : onOpenBranch(r.branch.name))} onContextMenu={(e) => branchMenu(e, r)} title={r.branch.last_commit?.summary} className={`group flex cursor-pointer items-start gap-2 px-3 py-1.5 ${dragCls("branches", r.branch.name)} ${currentBranch === r.branch.name ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
              {grip("branches", r.branch.name, r.branch.name, "opacity-0 group-hover:opacity-100", 6)}
              <div className="min-w-0 grow">
                <div className="flex items-center gap-1.5"><span className="truncate font-mono text-body font-medium">{r.branch.name}</span>{prByBranch[r.branch.name] && <PrBadge pr={prByBranch[r.branch.name]} />}</div>
                <Todo about="branch" items={[...syncTodo(r.branch, hasRemote), ...(r.branch.name === baseLocal ? [] : baseTodo(r, base))]} />
              </div>
              <MoreButton onOpen={(e) => branchMenu(e, r)} label={`Actions for ${r.branch.name}`} />
            </div>
          ))}
          {open.branches && data && without.length === 0 && <div className="px-3 py-1 text-label text-stone-500">Every local branch has a worktree.</div>}
    </>) : null,
    prs: !!prs ? (<>
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
              <div key={pr.number} onClick={see} onContextMenu={(e) => prMenu(e, pr, wtRow?.worktree.path)} title={`${pr.title}\n${pr.url}`} className="group flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
                {wtRow ? <span title="Has a worktree" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot({ status: wtRow.status, missing: !!wtRow.worktree.prunable, isMain: wtRow.isMain, loaded: !!data?.status_loaded }).cls}`} /> : null}
                <div className="min-w-0 grow">
                  <div className="flex items-baseline gap-1.5"><span className="shrink-0 font-mono text-label text-stone-500">#{pr.number}</span><span className="min-w-0 break-words font-medium">{pr.title}</span></div>
                  <div className="flex items-center gap-1 truncate text-label text-stone-500">
                    <ChecksMark checks={pr.checks} />
                    <span className="truncate">{pr.author}{pr.draft ? " · draft" : ""}{REVIEW[pr.review] ? ` · ${REVIEW[pr.review]}` : ""}{pr.from_fork ? " · from a fork" : ""}</span>
                  </div>
                </div>
                <MoreButton onOpen={(e) => prMenu(e, pr, wtRow?.worktree.path)} label={`Actions for #${pr.number}`} />
              </div>
            );
          })}
    </>) : null,
    stashes: stashes.length > 0 ? (<>
          {stashes.length > 0 && head("stashes", "STASHES", String(stashes.length))}
          {open.stashes && stashes.map((st) => (
            <div key={st.index} onContextMenu={(e) => stashMenu(e, st)} title={st.message} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
              <div className="min-w-0 grow">
                <div className="truncate font-medium">{st.message.replace(/^On [^:]+: /, "").replace(/^WIP on [^:]+: /, "")}</div>
                <div className="truncate text-label text-stone-500">{st.branch ? `from ${st.branch} · ` : ""}{ago(st.time)}</div>
              </div>
              <MoreButton onOpen={(e) => stashMenu(e, st)} label="Stash actions" />
            </div>
          ))}
    </>) : null,
    remote: true ? (<>
          {head("remote", "REMOTE BRANCHES", data ? String(remote.length) : "")}
          {open.remote && (
            <>
              <div className="px-3 pb-1">
                <input value={remoteQuery} onChange={(e) => setRemoteQuery(e.target.value)} placeholder="Search" className="h-6 w-full rounded border border-stone-300 bg-white px-1.5 text-label dark:border-stone-600 dark:bg-stone-700" />
              </div>
              {remoteShown.map((r: RemoteBranch) => (
                <div key={r.name} onClick={(e) => (wantsNewWindow(e) ? openInNewWindow({ kind: "branch", root, name: r.name }) : onOpenBranch(r.name))} onContextMenu={(e) => remoteMenu(e, r)} title={r.last_commit?.summary} className={`group flex cursor-pointer items-start gap-2 px-3 py-1.5 ${currentBranch === r.name ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
                  <div className="min-w-0 grow">
                    <div className="truncate font-mono text-body font-medium">{r.name}</div>
                    <div className="truncate text-label text-stone-500">{r.last_commit ? `${r.last_commit.author} · ${ago(r.last_commit.time)}` : ""}</div>
                  </div>
                  <MoreButton onOpen={(e) => remoteMenu(e, r)} label={`Actions for ${r.name}`} />
                </div>
              ))}
              {!q && remote.length > 8 && <div className="px-3 py-1 text-label text-stone-500">Showing 8 of {remote.length}. Type to search.</div>}
              {q && remoteShown.length === 0 && <div className="px-3 py-1 text-label text-stone-500">No match.</div>}
            </>
          )}
    </>) : null,
    tags: tags.length > 0 ? (<>
          {tags.length > 0 && head("tags", "TAGS", String(tags.length))}
          {tags.length > 0 && open.tags && (
            <>
              {tags.length > 8 && (
                <div className="px-3 pb-1">
                  <input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="Search" aria-label="Search tags" className="h-6 w-full rounded border border-stone-300 bg-white px-1.5 text-label dark:border-stone-600 dark:bg-stone-700" />
                </div>
              )}
              {tagsShown.map((t) => (
                <div key={t.name} onClick={() => showTag(t)} onContextMenu={(e) => tagMenu(e, t)} title={t.summary} className="group flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
                  <div className="min-w-0 grow">
                    <div className="truncate font-mono text-body font-medium">{t.name}</div>
                    <div className="truncate text-label text-stone-500">{t.target.slice(0, 7)}{t.time ? ` · ${ago(t.time)}` : ""}{t.summary ? ` · ${t.summary}` : ""}</div>
                  </div>
                  <MoreButton onOpen={(e) => tagMenu(e, t)} label={`Actions for tag ${t.name}`} />
                </div>
              ))}
              {!tq && tags.length > 8 && <div className="px-3 py-1 text-label text-stone-500">Showing the newest 8 of {tags.length}. Type to search.</div>}
              {tq && tagsShown.length === 0 && <div className="px-3 py-1 text-label text-stone-500">No match.</div>}
            </>
          )}
    </>) : null,
    backups: backups.length > 0 ? (<>
          {backups.length > 0 && head("backups", "BACKUPS", String(backups.length))}
          {open.backups && backups.map((b) => (
            <div key={b.refname} onContextMenu={(e) => backupMenu(e, b)} title={b.files.join("\n") || b.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-white dark:hover:bg-stone-800">
              <div className="min-w-0 grow">
                <div className={`truncate font-medium ${b.kind === "branch" ? "font-mono" : ""}`}>{b.kind === "branch" ? b.branch : backupTitle(b)}</div>
                <div className="truncate text-label text-stone-500">
                  {b.kind === "branch" ? (b.branch_exists ? "branch before a change" : "deleted branch") : `${b.files.length} ${b.files.length === 1 ? "file" : "files"}`} · {ago(b.time)}
                </div>
              </div>
              <MoreButton onOpen={(e) => backupMenu(e, b)} label={`Actions for backup ${b.branch ?? backupTitle(b)}`} />
            </div>
          ))}
    </>) : null,
  };

  const shownSections = order.filter((k) => parts[k]);
  shownKeys.current.sections = shownSections;
  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto bg-stone-50 text-body dark:bg-stone-900">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {picking && <BranchPicker x={picking.x} y={picking.y} branches={pickable(picking.row)} hint="Uncommitted changes come along if they don't clash." onPick={(name) => switchTo(picking.row, name)} onClose={() => setPicking(null)} />}
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

      {shownSections.map((k) => (
        <div key={k} ref={(el) => { els.current[`sections:${k}`] = el; }} data-section={k} className={dragCls("sections", k)}>
          {grip("sections", k, SECTION_NAME[k], "", GRIP_TOP[k])}
          {parts[k]}
        </div>
      ))}
      <div className="h-4" />
    </aside>
  );
}

const NO_BRANCH = "This folder has a commit checked out, not a branch. Commits made here belong to no branch and are easy to lose. Switch to a branch, or create one here.";
const MAIN_WORKTREE = "The original folder. It holds the repository itself; the other worktrees are linked to it. It can't be removed. The name has nothing to do with the main branch.";
type SectionKey = "base" | "worktrees" | "branches" | "all" | "prs" | "remote" | "tags" | "stashes" | "backups";
const SECTIONS: SectionKey[] = ["base", "worktrees", "branches", "all", "prs", "remote", "tags", "stashes", "backups"];
const SECTION_NAME: Record<SectionKey, string> = { base: "Base", worktrees: "Worktrees", branches: "Branches", all: "All branches", prs: "Pull requests", remote: "Remote branches", tags: "Tags", stashes: "Stashes", backups: "Backups" };
/// Where the handle sits, so it lines up with each section's first line.
const GRIP_TOP: Record<SectionKey, number> = { base: 16, all: 8, worktrees: 16, branches: 16, prs: 16, remote: 16, tags: 16, stashes: 16, backups: 16 };
const ORDER_KEY = "pando.sidebar.order";
const ROWS_KEY = "pando.sidebar.rows";
/// The saved order, with any section it doesn't know put at the end.
function loadOrder(): SectionKey[] {
  try {
    const saved = (JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as unknown[]).filter((k): k is SectionKey => SECTIONS.includes(k as SectionKey));
    const once = [...new Set(saved)];
    return [...once, ...SECTIONS.filter((k) => !once.includes(k))];
  } catch { return SECTIONS; }
}
const OPEN_KEY = "pando.sidebar.open";
const DEFAULT_OPEN: Record<string, boolean> = { base: true, worktrees: true, branches: true, prs: true, stashes: true, remote: false, backups: false };
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

type TodoItem = { text: string; tip?: string; tone?: "bad" | "done" | "quiet" } | null;
const count = (n: number, one: string, then = "") => `${n} ${n === 1 ? one : `${one}s`}${then ? ` ${then}` : ""}`;

/// What's left to do, each piece saying what it counts. Nothing to do: nothing shown.
/// `about` says what the facts describe: the folder, or the branch checked out in it.
function Todo({ items, about }: { items: TodoItem[]; about: "folder" | "branch" }) {
  const shown = items.filter((x): x is NonNullable<TodoItem> => !!x);
  if (shown.length === 0) return null;
  const tone = { bad: "text-red-700 dark:text-red-400", done: "text-teal-700 dark:text-teal-400", quiet: "text-stone-400" };
  return (
    <div data-todo={about} className="text-label text-stone-500">
      {shown.map((x, i) => <span key={x.text}>{i > 0 ? " · " : ""}<span title={x.tip} className={`whitespace-nowrap ${x.tone ? tone[x.tone] : ""}`}>{x.text}</span></span>)}
    </div>
  );
}

/// The branch against its own copy on the remote.
function syncTodo(b: Branch, hasRemote: boolean): TodoItem[] {
  if (!b.upstream) return hasRemote ? [{ text: "not pushed yet", tip: "This branch is only on this computer. Push to put a copy on the remote." }] : [];
  const up = b.ahead ?? 0, down = b.behind ?? 0;
  if (!up && !down) return [];
  if (b.upstream_rewritten) return [{ text: "needs a force push", tip: `You rewrote commits that are on ${b.upstream}. Force push to update it.` }];
  return [
    up ? { text: count(up, "commit", "to push"), tip: `${count(up, "commit")} here that ${b.upstream} doesn't have.` } : null,
    down ? { text: count(down, "commit", "to pull"), tip: `${count(down, "commit")} on ${b.upstream} that you don't have here.` } : null,
  ];
}

/// The branch against the base.
function baseTodo(r: BranchRow, base: string): TodoItem[] {
  const behind = r.behind_base ? [{ text: count(r.behind_base, "commit", `behind ${base}`), tip: `${base} has ${count(r.behind_base, "commit")} that this branch doesn't have.` }] : [];
  if (r.merged) return [{ text: `already in ${r.merged_in ?? base}`, tone: "done", tip: `Everything on this branch is already in ${r.merged_in ?? base}. Its worktree can be removed.` }, ...behind];
  return [...(r.ahead_of_base ? [{ text: count(r.ahead_of_base, "commit", `to merge into ${base}`), tip: `${count(r.ahead_of_base, "commit")} on this branch that ${base} doesn't have yet.` }] : []), ...behind];
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
      ⚠ {count} {count === 1 ? "file overlaps" : "files overlap"}
    </span>
  );
}
