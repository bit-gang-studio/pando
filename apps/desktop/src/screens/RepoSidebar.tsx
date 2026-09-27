import { useEffect, useState } from "react";
import { ago, api, changed, type BranchRow, type DetachedRow, type Overview as OverviewData, type RemoteBranch, type Summary, type Worktree } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { NewWindowIcon } from "../ui/icons";
import { MergeDialog } from "../dialogs/MergeDialog";
import { NewBranchDialog } from "../dialogs/NewBranchDialog";
import { confirm } from "../ui/Confirm";

type Props = { root: string; data: OverviewData | null; current?: string | null; currentBranch?: string | null; onOpenBranch: (name: string) => void; onOpenRepo: () => void; onRefresh: () => Promise<void>; onOpenWorktree: (path: string) => void; onError: (msg: string) => void };

const small = "h-6 rounded border border-stone-300 bg-white px-1.5 text-label hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const iconBtn = "inline-flex h-6 items-center rounded px-1 text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100";

type WtRow = { key: string; label: string; worktree: Worktree; status: Summary | null; branch: BranchRow | null; isMain: boolean; ahead: number | null; stale: boolean; time: number | null };

export function RepoSidebar({ root, data, current = null, currentBranch = null, onOpenBranch, onOpenRepo, onRefresh: refresh, onOpenWorktree, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ branch?: string; remote?: string } | null>(null);
  const [merging, setMerging] = useState<BranchRow | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteQuery, setRemoteQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating({}); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { await fn(); await refresh(); }
    catch (e) { onError(String(e)); }
    finally { setBusy(null); }
  }

  async function removeWorktree(row: WtRow) {
    const n = changed(row.status);
    const body = n > 0
      ? <><span className="font-mono">{row.label}</span> has {n} uncommitted {n === 1 ? "change" : "changes"}. They'll be lost. The branch is kept.</>
      : <>Remove the folder for <span className="font-mono">{row.label}</span>? The branch is kept.</>;
    if (!(await confirm({ title: "Remove worktree", body, action: "Remove worktree", danger: true })).ok) return;
    await run("remove", () => api.worktreeRemove(root, row.worktree.path, n > 0));
  }

  async function deleteBranch(r: BranchRow) {
    const b = r.branch;
    const unpushed = !b.upstream || (b.ahead ?? 0) > 0;
    const body = unpushed
      ? <><span className="font-mono">{b.name}</span> has commits that aren't on origin. Pando keeps a backup so it can be recovered.</>
      : <>Delete <span className="font-mono">{b.name}</span>? Pando keeps a backup so it can be recovered.</>;
    const answer = await confirm({ title: "Delete branch", body, action: "Delete branch", danger: true, checkbox: b.upstream ? { label: `Also delete ${b.upstream}` } : undefined });
    if (!answer.ok) return;
    await run("delete", () => api.branchDelete(root, b.name, answer.checked));
  }
  const branchMenu = (e: React.MouseEvent, r: BranchRow) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "Open", onClick: () => onOpenBranch(r.branch.name) },
      { label: "Open in new window", onClick: () => openInNewWindow({ kind: "branch", root, name: r.branch.name }) },
      { label: "Add worktree", onClick: () => setCreating({ branch: r.branch.name }) },
      { label: r.branch.upstream ? "Push" : "Push to origin", onClick: () => run("push", () => api.branchPush(root, r.branch.name)) },
      { label: "Delete branch", onClick: () => deleteBranch(r), danger: true },
    ] });
  };
  const remoteMenu = (e: React.MouseEvent, r: RemoteBranch) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "Open", onClick: () => onOpenBranch(r.name) },
      { label: "Open in new window", onClick: () => openInNewWindow({ kind: "branch", root, name: r.name }) },
      { label: "Add worktree", onClick: () => setCreating({ branch: r.short, remote: r.name }) },
    ] });
  };

  const openWin = (path: string) => openInNewWindow({ kind: "worktree", root, path }).catch((err) => onError(String(err)));
  const openRow = (e: React.MouseEvent, path: string) => (wantsNewWindow(e) ? openWin(path) : onOpenWorktree(path));
  const rowMenu = (e: React.MouseEvent, row: WtRow) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Open", onClick: () => onOpenWorktree(row.worktree.path) },
      { label: "Open in new window", onClick: () => openWin(row.worktree.path) },
    ];
    const b = row.branch?.branch;
    if (b) {
      if (b.upstream) items.push({ label: "Pull", onClick: () => run("pull", () => api.branchPull(row.worktree.path)) });
      items.push({ label: b.upstream ? "Push" : "Push to origin", onClick: () => run("push", () => api.branchPush(root, b.name)) });
    }
    if (!row.isMain && row.branch) items.push({ label: "Merge", onClick: () => setMerging(row.branch!) });
    if (!row.isMain) items.push({ label: "Remove worktree", onClick: () => removeWorktree(row), danger: true });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const rows: WtRow[] = [];
  for (const d of data?.detached ?? []) if (d.is_main_worktree) rows.push(detachedRow(d));
  for (const b of data?.branches ?? []) if (b.worktree) rows.push({ key: b.branch.name, label: b.branch.name, worktree: b.worktree, status: b.status, branch: b, isMain: b.is_main_worktree, ahead: b.ahead_of_base, stale: b.stale, time: b.branch.last_commit?.time ?? null });
  for (const d of data?.detached ?? []) if (!d.is_main_worktree) rows.push(detachedRow(d));

  const without = data?.branches.filter((r) => !r.worktree) ?? [];
  const remote = data?.remote_only ?? [];
  const q = remoteQuery.trim().toLowerCase();
  const remoteShown = q ? remote.filter((r) => r.name.toLowerCase().includes(q)) : remote.slice(0, 8);

  const head = (title: string, count: string) => (
    <div className="flex items-baseline gap-2 px-3 pb-1 pt-3">
      <span className="text-label font-semibold tracking-wider text-stone-500">{title}</span>
      <span className="text-label text-stone-400">{count}</span>
    </div>
  );

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto bg-stone-50 text-body dark:bg-stone-900">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {creating && data && (
        <NewBranchDialog root={root} base={data.base} initialBranch={creating.branch ?? null} remote={creating.remote ?? null} onClose={() => setCreating(null)} onCreated={refresh} />
      )}
      {merging && merging.worktree && (
        <MergeDialog root={root} path={merging.worktree.path} branch={merging.branch.name} headSummary={merging.branch.last_commit?.summary ?? null} onClose={() => setMerging(null)} onMerged={refresh} />
      )}

      <div className="flex items-center gap-1.5 border-b border-stone-200 px-3 py-2 dark:border-stone-700">
        <button onClick={() => setCreating({})} className="h-7 grow rounded-md bg-teal-700 px-2.5 text-body font-medium text-white hover:bg-teal-800">New branch<span className="ml-1.5 opacity-70">⌘N</span></button>
        <button onClick={() => run("fetch", () => api.fetchAll(root))} disabled={!!busy} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-body hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700">{busy === "fetch" ? "…" : "Fetch"}</button>
      </div>

      <button onClick={onOpenRepo} className={`mt-2 flex items-center gap-2 px-3 py-1.5 text-left ${current === null && currentBranch === null ? "bg-teal-50 font-medium dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
        <span className="h-2 w-2 shrink-0 rounded-full border-2 border-stone-400" />
        <span className="grow text-body">All branches</span>
        {data && (() => {
          const n = data.branches.reduce((t, b) => t + changed(b.status), 0) + data.detached.reduce((t, d) => t + changed(d.status), 0);
          return n > 0 ? <span className="text-label text-amber-700">{n} uncommitted</span> : null;
        })()}
      </button>

      {head("WORKTREES", data ? String(rows.length) : "…")}
      {rows.map((r) => {
        const n = changed(r.status);
        const conflicts = r.status?.conflicts ?? 0;
        const dot = r.worktree.prunable || conflicts ? "bg-red-700" : n > 0 ? "bg-amber-700" : r.isMain ? "bg-stone-400" : "bg-teal-700";
        const dotTip = r.worktree.prunable ? "Folder is missing" : conflicts ? "Has conflicts" : n > 0 ? "Has uncommitted changes" : r.isMain ? "Main worktree, clean" : "Clean";
        return (
          <div key={r.key} onClick={(e) => openRow(e, r.worktree.path)} onContextMenu={(e) => rowMenu(e, r)} title={r.worktree.path} className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${current === r.worktree.path ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
            <span title={dotTip} className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <div className="min-w-0 grow">
              <div className="truncate font-mono text-body font-medium">{r.label}</div>
              <div className="truncate text-label text-stone-500">
                {r.isMain ? "main worktree" : null}
                {r.isMain && (n > 0 || r.ahead) ? " · " : ""}
                {r.worktree.prunable ? "folder missing" : conflicts ? `${conflicts} conflicts` : n > 0 ? `${n} changed` : r.isMain ? "" : "clean"}
                {!r.isMain && r.ahead ? ` · ${r.ahead} ahead` : ""}
                {r.stale ? " · stale" : ""}
                {r.time ? ` · ${ago(r.time)}` : ""}
              </div>
            </div>
            <div className="hidden shrink-0 items-center gap-1 group-hover:flex" onClick={(e) => e.stopPropagation()}>
              {!r.isMain && r.branch && <button onClick={() => setMerging(r.branch)} disabled={!!busy} className={`${small} border-teal-700 text-teal-700`}>Merge</button>}
              {!r.isMain && <button onClick={() => removeWorktree(r)} disabled={!!busy} className={small} title="Remove worktree">Remove</button>}
              <button onClick={() => openWin(r.worktree.path)} title="Open in new window" aria-label={`Open ${r.label} in new window`} className={iconBtn}><NewWindowIcon /></button>
            </div>
          </div>
        );
      })}

      {head("BRANCHES", data ? `${without.length} without a worktree` : "")}
      {without.map((r) => (
        <div key={r.branch.name} onClick={(e) => (wantsNewWindow(e) ? openInNewWindow({ kind: "branch", root, name: r.branch.name }) : onOpenBranch(r.branch.name))} onContextMenu={(e) => branchMenu(e, r)} title={r.branch.last_commit?.summary} className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${currentBranch === r.branch.name ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-white dark:hover:bg-stone-800"}`}>
          <div className="min-w-0 grow">
            <div className="truncate font-mono text-body">{r.branch.name}</div>
            <div className="truncate text-label text-stone-500">{r.ahead_of_base ? `${r.ahead_of_base} ahead` : "0 ahead"}{r.branch.last_commit ? ` · ${ago(r.branch.last_commit.time)}` : ""}</div>
          </div>
          <button onClick={(e) => { e.stopPropagation(); setCreating({ branch: r.branch.name }); }} disabled={!!busy} className={`${small} hidden group-hover:block`}>Add worktree</button>
        </div>
      ))}
      {data && without.length === 0 && <div className="px-3 py-1 text-label text-stone-500">Every local branch has a worktree.</div>}

      <button onClick={() => setRemoteOpen((v) => !v)} className="flex items-baseline gap-2 px-3 pb-1 pt-3 text-left">
        <span className="text-label font-semibold tracking-wider text-stone-500">{remoteOpen ? "▾" : "▸"} REMOTE BRANCHES</span>
        <span className="text-label text-stone-400">{data ? remote.length : ""}</span>
      </button>
      {remoteOpen && (
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
            </div>
          ))}
          {!q && remote.length > 8 && <div className="px-3 py-1 text-label text-stone-500">Showing 8 of {remote.length}. Type to search.</div>}
          {q && remoteShown.length === 0 && <div className="px-3 py-1 text-label text-stone-500">No match.</div>}
        </>
      )}
      <div className="h-4" />
    </aside>
  );
}

function detachedRow(d: DetachedRow): WtRow {
  return { key: d.worktree.path, label: `detached at ${d.worktree.head?.slice(0, 7) ?? "?"}`, worktree: d.worktree, status: d.status, branch: null, isMain: d.is_main_worktree, ahead: null, stale: false, time: null };
}
