import { useCallback, useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ago, api, repoName, type Branch, type RemoteBranch } from "../lib/api";
import { Chip } from "../board/Chip";
import { BranchRail } from "./BranchRail";

type Props = {
  root: string;
  onOpenAsWorkspace: (branch: string) => void;
  onChanged: () => void;
};

const btn = "h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const COLS = "grid-cols-[16px_minmax(200px,1fr)_150px_100px_minmax(160px,1fr)_auto]";

export function Branches({ root, onOpenAsWorkspace, onChanged }: Props) {
  const [local, setLocal] = useState<Branch[]>([]);
  const [remote, setRemote] = useState<RemoteBranch[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showAllRemote, setShowAllRemote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<{ name: string; base: string } | null>(null);
  const [rename, setRename] = useState<{ from: string; to: string } | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([api.branchesList(root), api.branchesRemote(root)]);
      setLocal(l);
      setRemote(r);
      setTick((t) => t + 1);
      setSelected((s) => s ?? l.find((b) => b.checked_out_in)?.name ?? l[0]?.name ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [root]);

  const mainRow = local.find((b) => b.checked_out_in === root);
  const mainBranch = mainRow?.name ?? null;

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewBranch({ name: "", base: mainBranch ?? "" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mainBranch]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try { await fn(); await refresh(); onChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  }

  const q = filter.trim().toLowerCase();
  const localRows = local.filter((b) => !q || b.name.toLowerCase().includes(q));
  const untracked = useMemo(() => remote.filter((r) => !r.tracked), [remote]);
  const remoteRows = (showAllRemote ? untracked : untracked.slice(0, 5)).filter((r) => !q || r.name.toLowerCase().includes(q));

  async function switchInMain(name: string) {
    try {
      await api.branchSwitchMain(root, name, false);
    } catch (e) {
      const msg = String(e);
      if (/overwritten|uncommitted|local changes/i.test(msg)) {
        if (await ask(`The main worktree has uncommitted changes. Stash them, switch to ${name}, and re-apply?`, { title: "Switch branch", kind: "warning" })) {
          await api.branchSwitchMain(root, name, true);
        }
        return;
      }
      throw e;
    }
  }

  async function del(b: Branch) {
    const unpushed = b.upstream == null || (b.ahead ?? 0) > 0;
    const msg = unpushed
      ? `${b.name} has commits not on any remote. Delete it anyway? A backup ref is written first.`
      : `Delete ${b.name}? A backup ref is written first.`;
    if (!(await ask(msg, { title: "Delete branch", kind: "warning" }))) return;
    const alsoRemote = !!b.upstream && (await ask(`Also delete ${b.upstream} on the remote?`, { title: "Delete remote branch", kind: "warning" }));
    await run("delete", () => api.branchDelete(root, b.name, true, alsoRemote ? b.upstream!.split("/")[0] : null));
    if (selected === b.name) setSelected(null);
  }

  return (
    <div className="flex min-h-0 grow">
      <main className="flex min-w-0 grow flex-col gap-3 overflow-y-auto p-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">Branches</h1>
          <span className="text-stone-500">
            {repoName(root)} · {local.length} local · {remote.length} remote{mainBranch && <> · main worktree on <span className="font-mono text-xs">{mainBranch}</span></>}
          </span>
          <div className="grow" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-7 w-48 rounded-md border border-stone-300 bg-white px-2 text-xs dark:border-stone-600 dark:bg-stone-700" />
          <button onClick={() => run("fetch", () => api.fetchAll(root))} disabled={!!busy} className={btn}>{busy === "fetch" ? "Fetching…" : "Fetch all"}</button>
          <button onClick={() => setNewBranch({ name: "", base: mainBranch ?? "" })} className="h-7 rounded-md bg-teal-700 px-3 text-xs font-medium text-white hover:bg-teal-800">New branch <span className="opacity-70">⌘⇧N</span></button>
        </div>

        {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}

        {newBranch && (
          <form onSubmit={(e) => { e.preventDefault(); const nb = newBranch; setNewBranch(null); run("create", () => api.branchCreate(root, nb.name.trim(), nb.base || null)); }} className="flex items-center gap-2 rounded-lg border border-teal-700 bg-white p-3 dark:bg-stone-800">
            <label className="flex items-center gap-2 text-xs">Name <input autoFocus value={newBranch.name} onChange={(e) => setNewBranch({ ...newBranch, name: e.target.value })} placeholder="feat/x" className="h-7 w-56 rounded-md border border-stone-300 px-2 font-mono text-xs dark:border-stone-600 dark:bg-stone-700" /></label>
            <label className="flex items-center gap-2 text-xs">From <input value={newBranch.base} onChange={(e) => setNewBranch({ ...newBranch, base: e.target.value })} className="h-7 w-40 rounded-md border border-stone-300 px-2 font-mono text-xs dark:border-stone-600 dark:bg-stone-700" /></label>
            <span className="text-xs text-stone-500">Creates the branch only. Nothing is checked out.</span>
            <div className="grow" />
            <button type="button" onClick={() => setNewBranch(null)} className={btn}>Cancel</button>
            <button type="submit" disabled={!newBranch.name.trim()} className="h-7 rounded-md bg-teal-700 px-2.5 text-xs font-medium text-white disabled:opacity-40">Create</button>
          </form>
        )}

        <div className={`grid ${COLS} gap-3 px-3 text-[11px] font-semibold tracking-wider text-stone-500`}>
          <span /><span>BRANCH</span><span>CHECKED OUT IN</span><span>UPSTREAM</span><span>LAST COMMIT</span><span />
        </div>

        <section className="flex flex-col gap-1">
          <div className="px-1 text-xs font-medium text-stone-500">Local</div>
          {localRows.map((b) => {
            const inMain = b.checked_out_in === root;
            const inWs = !!b.checked_out_in && !inMain;
            const checkedOut = inMain || inWs;
            const sel = selected === b.name;
            const isRename = rename?.from === b.name;
            return (
              <div key={b.name} onClick={() => setSelected(b.name)} className={`grid ${COLS} cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${sel ? "border-teal-700 bg-white dark:bg-stone-800" : "border-stone-300 bg-white hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800"}`}>
                <span className={`h-2 w-2 rounded-full ${checkedOut ? "bg-teal-700" : "bg-stone-400"}`} />
                {isRename ? (
                  <form onSubmit={(e) => { e.preventDefault(); const r = rename; setRename(null); if (selected === r.from) setSelected(r.to.trim()); run("rename", () => api.branchRename(root, r.from, r.to.trim())); }} onClick={(e) => e.stopPropagation()}>
                    <input autoFocus value={rename.to} onChange={(e) => setRename({ ...rename, to: e.target.value })} onBlur={() => setRename(null)} className="h-6 w-full rounded border border-teal-700 px-1.5 font-mono text-xs dark:bg-stone-700" />
                  </form>
                ) : (
                  <span className="truncate font-mono text-[13px] font-medium">{b.name}</span>
                )}
                <span>
                  {inMain ? <Chip>main worktree</Chip> : inWs ? <Chip tone="teal">workspace</Chip> : <span className="text-xs text-stone-500">not checked out</span>}
                </span>
                <span>
                  {b.upstream == null ? <Chip>no upstream</Chip>
                    : (b.ahead ?? 0) === 0 && (b.behind ?? 0) === 0 ? <Chip>in sync</Chip>
                    : <Chip tone={(b.behind ?? 0) > 0 ? "amber" : "grey"}>↑{b.ahead} ↓{b.behind}</Chip>}
                </span>
                <span className="truncate text-xs">
                  {b.last_commit && <><span className="font-mono text-stone-500">{b.last_commit.id.slice(0, 7)}</span> {b.last_commit.summary} <span className="text-stone-500">· {ago(b.last_commit.time)}</span></>}
                </span>
                <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {inMain && <button onClick={() => run("pull", () => api.branchPull(root, true))} disabled={!!busy || !b.upstream} className={btn}>Pull</button>}
                  {inWs && <button onClick={() => api.openInEditor(b.checked_out_in!)} className={btn}>Open workspace</button>}
                  {!checkedOut && (
                    <>
                      <button onClick={() => run("switch", () => switchInMain(b.name))} disabled={!!busy} className={btn}>Switch in main</button>
                      <button onClick={() => onOpenAsWorkspace(b.name)} className={`${btn} border-teal-700 font-medium text-teal-700`}>Open as workspace</button>
                    </>
                  )}
                  <button onClick={() => run("push", () => api.branchPush(root, b.name, false))} disabled={!!busy} className={btn}>Push</button>
                  <button onClick={() => setRename({ from: b.name, to: b.name })} disabled={checkedOut} className={btn} title={checkedOut ? "Checked out; remove the workspace first" : "Rename"}>Rename</button>
                  <button onClick={() => del(b)} disabled={checkedOut || !!busy} className={`${btn} text-red-700`} title={checkedOut ? "Checked out; remove the workspace first" : "Delete"}>Delete</button>
                </div>
              </div>
            );
          })}
          {localRows.length === 0 && <div className="px-1 text-xs text-stone-500">No local branches match.</div>}
        </section>

        <section className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1 text-xs font-medium text-stone-500">
            <span>Remote only</span>
            <span className="text-stone-400">{untracked.length}{!showAllRemote && untracked.length > 5 ? ", showing 5" : ""}</span>
          </div>
          {remoteRows.map((r) => (
            <div key={r.name} className={`grid ${COLS} items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-700 dark:bg-stone-800/60`}>
              <span />
              <span className="truncate font-mono text-[13px] text-stone-700 dark:text-stone-300">{r.name}</span>
              <span className="text-xs text-stone-500">not local</span>
              <span />
              <span className="truncate text-xs">
                {r.last_commit && <><span className="font-mono text-stone-500">{r.last_commit.id.slice(0, 7)}</span> {r.last_commit.summary} <span className="text-stone-500">· {ago(r.last_commit.time)}</span></>}
              </span>
              <div className="flex justify-end gap-1.5">
                <button onClick={() => run("track", () => api.branchTrackRemote(root, r.name, r.short))} disabled={!!busy} className={btn}>Track locally</button>
                <button onClick={() => run("track", async () => { await api.branchTrackRemote(root, r.name, r.short); onOpenAsWorkspace(r.short); })} disabled={!!busy} className={`${btn} border-teal-700 font-medium text-teal-700`}>Open as workspace</button>
              </div>
            </div>
          ))}
          {untracked.length > 5 && (
            <button onClick={() => setShowAllRemote((v) => !v)} className="self-start px-1 text-xs text-teal-700 underline">{showAllRemote ? "Show fewer" : `Show all ${untracked.length} remote branches`}</button>
          )}
          {untracked.length === 0 && <div className="px-1 text-xs text-stone-500">Every remote branch has a local branch.</div>}
        </section>
      </main>

      <BranchRail root={root} branch={local.find((b) => b.name === selected) ?? null} mainBranch={mainBranch} refreshKey={tick} onChanged={() => { refresh(); onChanged(); }} />
    </div>
  );
}
