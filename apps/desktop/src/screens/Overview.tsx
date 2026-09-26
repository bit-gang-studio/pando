import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ago, api, changed, type BranchRow, type DetachedRow, type Overview as OverviewData, type RemoteBranch, type Summary, type Worktree } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { Chip } from "../ui/Chip";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { NewWindowIcon } from "../ui/icons";
import { MergeDialog } from "../dialogs/MergeDialog";
import { NewBranchDialog } from "../dialogs/NewBranchDialog";

type Props = { root: string; data: OverviewData | null; onRefresh: () => Promise<void>; onOpenDetail: (path: string) => void; onError: (msg: string) => void };

const btn = "h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const th = "px-2 py-1.5 text-left text-[11px] font-semibold tracking-wider text-stone-500";
const td = "px-2 py-1.5 align-middle";
const iconBtn = "inline-flex items-center rounded px-1.5 py-1 text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100";

type WtRow = { key: string; label: string; sub: string | null; worktree: Worktree; status: Summary | null; branch: BranchRow | null; isMain: boolean; ahead: number | null; port: number | null; stale: boolean; time: number | null };

export function Overview({ root, data, onRefresh: refresh, onOpenDetail, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ branch?: string } | null>(null);
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
    const msg = n > 0
      ? `${row.label} has ${n} uncommitted ${n === 1 ? "change" : "changes"}. Remove the worktree anyway? The branch is kept.`
      : `Remove the worktree for ${row.label}? The branch is kept.`;
    if (!(await ask(msg, { title: "Remove worktree", kind: "warning" }))) return;
    await run("remove", () => api.worktreeRemove(root, row.worktree.path, n > 0));
  }

  const openWin = (path: string) => openInNewWindow({ kind: "worktree", root, path }).catch((err) => onError(String(err)));
  const openRow = (e: React.MouseEvent, path: string) => (wantsNewWindow(e) ? openWin(path) : onOpenDetail(path));
  const rowMenu = (e: React.MouseEvent, row: WtRow) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Open", onClick: () => onOpenDetail(row.worktree.path) },
      { label: "Open in new window", onClick: () => openWin(row.worktree.path) },
    ];
    if (!row.isMain && row.branch) items.push({ label: "Merge", onClick: () => setMerging(row.branch!) });
    if (!row.isMain) items.push({ label: "Remove worktree", onClick: () => removeWorktree(row), danger: true });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const rows: WtRow[] = [];
  for (const d of data?.detached ?? []) if (d.is_main_worktree) rows.push(detachedRow(d));
  for (const b of data?.branches ?? []) if (b.worktree) rows.push({ key: b.branch.name, label: b.branch.name, sub: null, worktree: b.worktree, status: b.status, branch: b, isMain: b.is_main_worktree, ahead: b.ahead_of_base, port: b.port, stale: b.stale, time: b.branch.last_commit?.time ?? null });
  for (const d of data?.detached ?? []) if (!d.is_main_worktree) rows.push(detachedRow(d));

  const without = data?.branches.filter((r) => !r.worktree) ?? [];
  const remote = data?.remote_only ?? [];
  const q = remoteQuery.trim().toLowerCase();
  const remoteShown = q ? remote.filter((r) => r.name.toLowerCase().includes(q)) : remote.slice(0, 8);
  const base = data?.base ?? "main";

  return (
    <main className="flex min-w-0 grow flex-col gap-6 overflow-auto p-5">
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {creating && data && (
        <NewBranchDialog root={root} base={data.base} initialBranch={creating.branch ?? null} onClose={() => setCreating(null)} onCreated={refresh} />
      )}
      {merging && merging.worktree && (
        <MergeDialog root={root} path={merging.worktree.path} branch={merging.branch.name} headSummary={merging.branch.last_commit?.summary ?? null} onClose={() => setMerging(null)} onMerged={refresh} />
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">Worktrees</h1>
          <span className="text-xs text-stone-500">{data ? `${rows.length} on this machine` : "…"}</span>
          <div className="grow" />
          <button onClick={() => run("fetch", () => api.fetchAll(root))} disabled={!!busy} className={btn}>{busy === "fetch" ? "Fetching…" : "Fetch"}</button>
          <button onClick={() => setCreating({})} className="h-7 rounded-md bg-teal-700 px-3 text-xs font-medium text-white hover:bg-teal-800">New branch<span className="ml-2 opacity-70">⌘N</span></button>
        </div>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${th} w-4`}></th>
              <th className={`${th} w-[260px]`}>BRANCH</th>
              <th className={th}>PATH</th>
              <th className={`${th} w-[110px]`}>CHANGES</th>
              <th className={`${th} w-[130px]`}>AHEAD OF {base.toUpperCase()}</th>
              <th className={`${th} w-[80px] text-right`}>LAST</th>
              <th className={`${th} w-[250px]`}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const n = changed(r.status);
              const conflicts = r.status?.conflicts ?? 0;
              const dot = r.worktree.prunable || conflicts ? "bg-red-700" : n > 0 ? "bg-amber-700" : r.isMain ? "bg-stone-400" : "bg-teal-700";
              return (
                <tr key={r.key} onClick={(e) => openRow(e, r.worktree.path)} onContextMenu={(e) => rowMenu(e, r)} className="cursor-pointer border-t border-stone-200 hover:bg-white dark:border-stone-700 dark:hover:bg-stone-800">
                  <td className={td}><span className={`block h-2 w-2 rounded-full ${dot}`} /></td>
                  <td className={`${td} font-mono font-medium`}>
                    {r.label}
                    {r.isMain && <span className="ml-2 font-sans text-xs font-normal text-stone-500">main worktree</span>}
                    {r.sub && <span className="ml-2 font-sans text-xs font-normal text-stone-500">{r.sub}</span>}
                  </td>
                  <td className={`${td} max-w-0 truncate`}>
                    <span className="text-xs text-stone-500" title={r.worktree.path}>{r.worktree.path}</span>
                  </td>
                  <td className={td}>
                    {r.worktree.prunable ? <Chip tone="red">folder missing</Chip> : conflicts > 0 ? <Chip tone="red">{conflicts} conflicts</Chip> : r.status ? (n === 0 ? <span className="text-xs text-stone-500">clean</span> : <Chip tone="amber">{n} changed</Chip>) : null}
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {r.isMain ? (r.branch?.branch.behind ? <Chip tone="amber">{r.branch.branch.behind} behind {r.branch.branch.upstream}</Chip> : null) : r.ahead ? r.ahead : <span className="text-stone-400">0</span>}
                    {r.stale && <Chip>stale</Chip>}
                  </td>
                  <td className={`${td} text-right text-xs text-stone-500`}>{r.time ? ago(r.time) : ""}</td>
                  <td className={`${td} text-right`} onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1.5">
                      {!r.isMain && r.branch && <button onClick={() => setMerging(r.branch)} disabled={!!busy} className={`${btn} border-teal-700 font-medium text-teal-700`}>Merge</button>}
                      {!r.isMain && <button onClick={() => removeWorktree(r)} disabled={!!busy} className={btn}>Remove worktree</button>}
                      <button onClick={() => openWin(r.worktree.path)} title="Open in new window" aria-label={`Open ${r.label} in new window`} className={iconBtn}><NewWindowIcon /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-base font-semibold">Branches</h2>
          <span className="text-xs text-stone-500">{data ? `${without.length} local without a worktree` : ""}</span>
        </div>
        {without.length > 0 ? (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={`${th} w-[360px]`}>BRANCH</th>
                <th className={`${th} w-[130px]`}>AHEAD OF {base.toUpperCase()}</th>
                <th className={th}>LAST COMMIT</th>
                <th className={`${th} w-[80px] text-right`}>LAST</th>
                <th className={`${th} w-[130px]`}></th>
              </tr>
            </thead>
            <tbody>
              {without.map((r) => (
                <tr key={r.branch.name} className="border-t border-stone-200 dark:border-stone-700">
                  <td className={`${td} font-mono`}>{r.branch.name}</td>
                  <td className={`${td} tabular-nums`}>{r.ahead_of_base ? r.ahead_of_base : <span className="text-stone-400">0</span>}</td>
                  <td className={`${td} max-w-0 truncate text-xs text-stone-500`} title={r.branch.last_commit?.summary}>{r.branch.last_commit?.summary}</td>
                  <td className={`${td} text-right text-xs text-stone-500`}>{r.branch.last_commit && ago(r.branch.last_commit.time)}</td>
                  <td className={`${td} text-right`}><button onClick={() => setCreating({ branch: r.branch.name })} disabled={!!busy} className={btn}>Add worktree</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          data && <span className="px-1 text-xs text-stone-500">Every local branch has a worktree.</span>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <button onClick={() => setRemoteOpen((v) => !v)} className="flex items-baseline gap-2 text-base font-semibold">
            <span className="text-xs text-stone-400">{remoteOpen ? "▾" : "▸"}</span>Remote branches
          </button>
          <span className="text-xs text-stone-500">{data ? `${remote.length} on the remote with no local branch` : ""}</span>
          <div className="grow" />
          {remoteOpen && <input value={remoteQuery} onChange={(e) => setRemoteQuery(e.target.value)} placeholder="Search remote branches" className="h-7 w-64 rounded-md border border-stone-300 bg-white px-2 text-xs dark:border-stone-600 dark:bg-stone-700" />}
        </div>
        {remoteOpen && (
          <>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${th} w-[360px]`}>BRANCH</th>
                  <th className={th}>LAST COMMIT</th>
                  <th className={`${th} w-[80px] text-right`}>LAST</th>
                  <th className={`${th} w-[130px]`}></th>
                </tr>
              </thead>
              <tbody>
                {remoteShown.map((r: RemoteBranch) => (
                  <tr key={r.name} className="border-t border-stone-200 dark:border-stone-700">
                    <td className={`${td} font-mono text-stone-600 dark:text-stone-300`}>{r.name}</td>
                    <td className={`${td} max-w-0 truncate text-xs text-stone-500`} title={r.last_commit?.summary}>{r.last_commit && `${r.last_commit.author} · ${r.last_commit.summary}`}</td>
                    <td className={`${td} text-right text-xs text-stone-500`}>{r.last_commit && ago(r.last_commit.time)}</td>
                    <td className={`${td} text-right`}><button onClick={() => setCreating({ branch: r.short })} disabled={!!busy} className={btn}>Add worktree</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!q && remote.length > 8 && <span className="px-1 text-xs text-stone-500">Showing 8 of {remote.length}. Type to search the rest.</span>}
            {q && remoteShown.length === 0 && <span className="px-1 text-xs text-stone-500">No remote branch matches.</span>}
          </>
        )}
      </section>
    </main>
  );
}

function detachedRow(d: DetachedRow): WtRow {
  return {
    key: d.worktree.path,
    label: `detached at ${d.worktree.head?.slice(0, 7) ?? "?"}`,
    sub: "no branch",
    worktree: d.worktree,
    status: d.status,
    branch: null,
    isMain: d.is_main_worktree,
    ahead: null,
    port: null,
    stale: false,
    time: null,
  };
}
