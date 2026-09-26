import { useCallback, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ago, api, changed, type BranchRow, type Overview as OverviewData, type RemoteBranch } from "../lib/api";
import { Chip } from "../ui/Chip";
import { MergeDialog } from "../dialogs/MergeDialog";
import { NewBranchDialog } from "../dialogs/NewBranchDialog";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";

type Props = { root: string; onOpenDetail: (path: string) => void; onError: (msg: string) => void };

const REFRESH_MS = 4000;
const btn = "h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";

export function Overview({ root, onOpenDetail, onError }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ branch?: string; remote?: string } | null>(null);
  const [merging, setMerging] = useState<BranchRow | null>(null);
  const [showAllRemote, setShowAllRemote] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function rowMenu(e: React.MouseEvent, path: string, extra: MenuItem[] = []) {
    e.preventDefault();
    const route = { kind: "worktree" as const, root, path };
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "Open", onClick: () => onOpenDetail(path) },
      { label: "Open in new window", onClick: () => openInNewWindow(route).catch((err) => onError(String(err))) },
      { label: "Open in editor", onClick: () => api.openInEditor(path) },
      ...extra,
    ] });
  }
  function openRow(e: React.MouseEvent, path: string) {
    if (wantsNewWindow(e)) openInNewWindow({ kind: "worktree", root, path }).catch((err) => onError(String(err)));
    else onOpenDetail(path);
  }

  const refresh = useCallback(async () => {
    try { setData(await api.overview(root)); }
    catch (e) { onError(String(e)); }
  }, [root, onError]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, REFRESH_MS);
    const onFocus = () => refresh();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating({}); }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); window.removeEventListener("keydown", onKey); };
  }, [refresh]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { await fn(); await refresh(); }
    catch (e) { onError(String(e)); }
    finally { setBusy(null); }
  }

  async function removeWorktree(r: BranchRow) {
    const wt = r.worktree!;
    const n = changed(r.status);
    const msg = n > 0
      ? `${r.branch.name} has ${n} uncommitted ${n === 1 ? "change" : "changes"}. Remove the worktree anyway? The branch is kept.`
      : `Remove the worktree for ${r.branch.name}? The branch is kept.`;
    if (!(await ask(msg, { title: "Remove worktree", kind: "warning" }))) return;
    await run("remove", () => api.worktreeRemove(root, wt.path, n > 0));
  }

  const withWt = data?.branches.filter((r) => r.worktree) ?? [];
  const detached = data?.detached ?? [];
  const without = data?.branches.filter((r) => !r.worktree) ?? [];
  const remote = data?.remote_only ?? [];
  const remoteShown = showAllRemote ? remote : remote.slice(0, 5);

  return (
    <main className="flex min-w-0 grow flex-col gap-6 overflow-auto p-6">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {creating && data && (
        <NewBranchDialog root={root} base={data.base} initialBranch={creating.branch ?? null} onClose={() => setCreating(null)} onCreated={refresh} />
      )}
      {merging && merging.worktree && (
        <MergeDialog root={root} path={merging.worktree.path} branch={merging.branch.name} headSummary={merging.branch.last_commit?.summary ?? null} onClose={() => setMerging(null)} onMerged={refresh} />
      )}

      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">Worktrees</h1>
          <span className="text-xs text-stone-500">{data ? `${withWt.length + detached.length} on this machine` : "…"}</span>
          <div className="grow" />
          <button onClick={() => run("fetch", () => api.fetchAll(root))} disabled={!!busy} className={btn}>{busy === "fetch" ? "Fetching…" : "Fetch"}</button>
          <button onClick={() => setCreating({})} className="h-7 rounded-md bg-teal-700 px-3 text-xs font-medium text-white hover:bg-teal-800">New branch<span className="ml-2 opacity-70">⌘N</span></button>
        </div>
        {detached.filter((d) => d.is_main_worktree).map((d) => <DetachedRowView key={d.worktree.path} d={d} onOpen={(e) => openRow(e, d.worktree.path)} onMenu={(e) => rowMenu(e, d.worktree.path)} />)}
        {withWt.map((r) => (
          <Row key={r.branch.name} r={r} base={data?.base ?? null} busy={busy}
            onOpen={(e) => openRow(e, r.worktree!.path)}
            onMenu={(e) => rowMenu(e, r.worktree!.path, r.is_main_worktree ? [] : [
              { label: "Merge", onClick: () => setMerging(r) },
              { label: "Remove worktree", onClick: () => removeWorktree(r), danger: true },
            ])}
            onMerge={r.is_main_worktree ? undefined : () => setMerging(r)}
            onRemove={r.is_main_worktree ? undefined : () => removeWorktree(r)} />
        ))}
        {detached.filter((d) => !d.is_main_worktree).map((d) => (
          <DetachedRowView key={d.worktree.path} d={d} onOpen={(e) => openRow(e, d.worktree.path)} onMenu={(e) => rowMenu(e, d.worktree.path)}
            onRemove={async () => {
              const n = changed(d.status);
              if (!(await ask(n > 0 ? `This worktree has ${n} uncommitted changes and no branch. Remove it anyway?` : "Remove this worktree?", { title: "Remove worktree", kind: "warning" }))) return;
              await run("remove", () => api.worktreeRemove(root, d.worktree.path, n > 0));
            }} />
        ))}
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-base font-semibold">Other branches</h2>
          <span className="text-xs text-stone-500">{data ? `${without.length} local · ${remote.length} on the remote only` : ""}</span>
        </div>
        {without.map((r) => (
          <div key={r.branch.name} className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-800">
            <span className="font-mono text-[13px]">{r.branch.name}</span>
            <span className="text-xs text-stone-500">
              {r.ahead_of_base ? `${r.ahead_of_base} ahead of ${data?.base}` : ""}
              {r.branch.last_commit && ` · ${ago(r.branch.last_commit.time)}`}
            </span>
            <div className="grow" />
            <button onClick={() => setCreating({ branch: r.branch.name })} disabled={!!busy} className={btn}>Add worktree</button>
          </div>
        ))}
        {remoteShown.map((r: RemoteBranch) => (
          <div key={r.name} className="flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-700 dark:bg-stone-800/60">
            <span className="font-mono text-[13px] text-stone-600 dark:text-stone-300">{r.name}</span>
            <span className="text-xs text-stone-500">{r.last_commit && `${r.last_commit.author} · ${ago(r.last_commit.time)}`}</span>
            <div className="grow" />
            <button onClick={() => setCreating({ branch: r.short, remote: r.name })} disabled={!!busy} className={btn}>Add worktree</button>
          </div>
        ))}
        {remote.length > 5 && (
          <button onClick={() => setShowAllRemote((v) => !v)} className="self-start px-1 text-xs text-teal-700 underline">{showAllRemote ? "Show fewer" : `Show all ${remote.length} remote branches`}</button>
        )}
        {data && without.length + remote.length === 0 && <span className="px-1 text-xs text-stone-500">Every branch has a worktree.</span>}
      </section>
    </main>
  );
}

function Row({ r, base, busy, onOpen, onMenu, onMerge, onRemove }: { r: BranchRow; base: string | null; busy: string | null; onOpen: (e: React.MouseEvent) => void; onMenu: (e: React.MouseEvent) => void; onMerge?: () => void; onRemove?: () => void }) {
  const wt = r.worktree!;
  const n = changed(r.status);
  const conflicts = r.status?.conflicts ?? 0;
  const dot = wt.prunable || conflicts ? "bg-red-700" : n > 0 ? "bg-amber-700" : "bg-teal-700";
  return (
    <div onClick={onOpen} onContextMenu={onMenu} className="flex cursor-pointer items-center gap-3 rounded-lg border border-stone-300 bg-white px-3 py-2.5 hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0">
        <div className="truncate font-mono text-[13px] font-medium">
          {r.branch.name}
          {r.is_main_worktree && <span className="ml-2 font-sans text-xs font-normal text-stone-500">main worktree</span>}
        </div>
        <button onClick={(e) => { e.stopPropagation(); api.openInEditor(wt.path); }} className="truncate text-left text-xs text-stone-500 hover:text-teal-700 hover:underline" title={`Open ${wt.path} in your editor`}>{wt.path}</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {wt.prunable ? <Chip tone="red">folder missing</Chip> : r.status ? (n === 0 ? <Chip>clean</Chip> : <Chip tone="amber">{n} changed</Chip>) : null}
        {conflicts > 0 && <Chip tone="red">{conflicts} conflicts</Chip>}
        {!r.is_main_worktree && (r.ahead_of_base ?? 0) > 0 && <Chip>{r.ahead_of_base} ahead of {base}</Chip>}
        {r.is_main_worktree && r.branch.behind != null && r.branch.behind > 0 && <Chip tone="amber">{r.branch.behind} behind {r.branch.upstream}</Chip>}
        {r.port != null && <Chip mono>:{r.port}</Chip>}
        {r.stale && <Chip>stale</Chip>}
        {wt.locked != null && <Chip>locked</Chip>}
      </div>
      <div className="grow" />
      <span className="shrink-0 text-xs text-stone-500">{r.branch.last_commit && ago(r.branch.last_commit.time)}</span>
      <div className="flex shrink-0 gap-1.5" onClick={(e) => e.stopPropagation()}>
        {onMerge && <button onClick={onMerge} disabled={!!busy} className={`${btn} border-teal-700 font-medium text-teal-700`}>Merge</button>}
        {onRemove && <button onClick={onRemove} disabled={!!busy} className={btn}>Remove worktree</button>}
      </div>
    </div>
  );
}

function DetachedRowView({ d, onOpen, onMenu, onRemove }: { d: import("../lib/api").DetachedRow; onOpen: (e: React.MouseEvent) => void; onMenu: (e: React.MouseEvent) => void; onRemove?: () => void }) {
  const n = changed(d.status);
  const head = d.worktree.head?.slice(0, 7) ?? "?";
  return (
    <div onClick={onOpen} onContextMenu={onMenu} className="flex cursor-pointer items-center gap-3 rounded-lg border border-stone-300 bg-white px-3 py-2.5 hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800">
      <span className={`h-2 w-2 shrink-0 rounded-full ${n > 0 ? "bg-amber-700" : "bg-stone-400"}`} />
      <div className="min-w-0">
        <div className="truncate font-mono text-[13px] font-medium">
          detached at {head}
          {d.is_main_worktree && <span className="ml-2 font-sans text-xs font-normal text-stone-500">main worktree</span>}
        </div>
        <button onClick={(e) => { e.stopPropagation(); api.openInEditor(d.worktree.path); }} className="truncate text-left text-xs text-stone-500 hover:text-teal-700 hover:underline">{d.worktree.path}</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>no branch</Chip>
        {d.status && (n === 0 ? <Chip>clean</Chip> : <Chip tone="amber">{n} changed</Chip>)}
      </div>
      <div className="grow" />
      {onRemove && <div className="flex shrink-0 gap-1.5" onClick={(e) => e.stopPropagation()}><button onClick={onRemove} className={btn}>Remove worktree</button></div>}
    </div>
  );
}
