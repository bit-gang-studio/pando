import { useEffect, useState } from "react";
import { ago, api, bytes, repoName, type Candidate, type LandStep } from "../lib/api";
import { Chip } from "../board/Chip";

type Props = { repos: string[]; onClose: () => void; onDone: () => void };
type Row = Candidate & { root: string };

const btn = "h-8 rounded-lg border border-stone-300 bg-white px-3 text-[13px] dark:border-stone-600 dark:bg-stone-700";
const reasonChip = (r: Row) => {
  switch (r.reason) {
    case "merged": return <Chip tone="teal">merged into base</Chip>;
    case "missing": return <Chip tone="red">missing on disk</Chip>;
    case "empty": return <Chip>no commits · no changes</Chip>;
    case "idle": return <Chip tone="amber">uncommitted changes</Chip>;
  }
};

export function CleanDialog({ repos, onClose, onDone }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteBranches, setDeleteBranches] = useState(true);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [skipUnpushed, setSkipUnpushed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LandStep[] | null>(null);

  useEffect(() => {
    Promise.all(repos.map((root) => api.cleanPlan(root).then((cs) => cs.map((c) => ({ ...c, root }))).catch((e) => { setError(String(e)); return [] as Row[]; })))
      .then((all) => {
        const flat = all.flat();
        setRows(flat);
        setSelected(new Set(flat.filter((r) => !r.unpushed && r.reason !== "idle").map((r) => r.path)));
      });
  }, [repos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const picked = (rows ?? []).filter((r) => selected.has(r.path));
  const totalBytes = picked.reduce((n, r) => n + r.disk_bytes, 0);

  async function run() {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const byRoot = new Map<string, string[]>();
      for (const r of picked) byRoot.set(r.root, [...(byRoot.get(r.root) ?? []), r.path]);
      const steps: LandStep[] = [];
      for (const [root, paths] of byRoot) {
        steps.push(...(await api.cleanRun(root, { paths, delete_branches: deleteBranches, delete_remote: deleteRemote, skip_unpushed: skipUnpushed })));
      }
      setResult(steps);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (p: string) => setSelected((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" className="flex max-h-[90vh] w-[860px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-[13px] shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex flex-col gap-1 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 className="text-base font-semibold">Clean up worktrees</h2>
          <span className="text-xs text-stone-500">
            {rows ? `${rows.length} ${rows.length === 1 ? "candidate" : "candidates"} across ${repos.length} ${repos.length === 1 ? "repository" : "repositories"} · ${bytes(rows.reduce((n, r) => n + r.disk_bytes, 0))} reclaimable. Locked worktrees are never listed.` : "Looking…"}
          </span>
        </div>

        <div className="flex grow flex-col overflow-y-auto px-5 py-3">
          {error && <div className="mb-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}
          {!result && rows && rows.length === 0 && <div className="py-8 text-center text-stone-500">Nothing to clean. Every worktree has work in it.</div>}
          {!result && rows && rows.length > 0 && (
            <>
              <div className="grid grid-cols-[28px_1fr_240px_80px_90px] gap-3 px-2 py-1.5 text-[11px] font-semibold tracking-wider text-stone-500">
                <input type="checkbox" checked={picked.length === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.path)) : new Set())} aria-label="Select all" className="m-0" />
                <span>WORKTREE</span><span>REASON</span><span>DISK</span><span>LAST COMMIT</span>
              </div>
              {rows.map((r) => (
                <label key={r.path} className="grid cursor-pointer grid-cols-[28px_1fr_240px_80px_90px] items-center gap-3 border-t border-stone-200 px-2 py-2 hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-700/40">
                  <input type="checkbox" checked={selected.has(r.path)} onChange={() => toggle(r.path)} className="m-0" />
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs font-medium">{repoName(r.root)} / {r.branch ?? "(detached)"}</div>
                    <div className="truncate text-[11px] text-stone-500" title={r.path}>{r.path}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">{reasonChip(r)}{r.unpushed && <Chip tone="amber">unpushed</Chip>}<span className="text-[11px] text-stone-500">{r.detail}</span></div>
                  <span className="text-xs">{r.reason === "missing" ? "—" : bytes(r.disk_bytes)}</span>
                  <span className="text-xs text-stone-500">{ago(r.last_commit_at)}</span>
                </label>
              ))}
              <div className="flex flex-wrap gap-5 pt-4 text-[13px]">
                <label className="flex items-center gap-2"><input type="checkbox" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} /> Delete local branches</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={deleteRemote} disabled={!deleteBranches} onChange={(e) => setDeleteRemote(e.target.checked)} /> Delete remote branches</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={skipUnpushed} onChange={(e) => setSkipUnpushed(e.target.checked)} /> Skip worktrees with unpushed work</label>
              </div>
            </>
          )}
          {result && (
            <div className="flex flex-col gap-1.5">
              {result.map((s, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-md border border-stone-200 p-2 dark:border-stone-700">
                  <div className="flex items-center gap-2"><span className={`font-semibold ${s.ok ? "text-teal-700" : "text-red-700"}`}>{s.ok ? "✓" : "✕"}</span><span>{s.name}</span></div>
                  {s.output.trim() && <pre className="max-h-24 overflow-auto rounded bg-stone-900 p-2 font-mono text-[11px] text-stone-100">{s.output.trim()}</pre>}
                </div>
              ))}
              {result.length === 0 && <span className="text-stone-500">Nothing was removed.</span>}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-50 px-5 py-3.5 dark:border-stone-700 dark:bg-stone-900/40">
          <span className="text-xs text-stone-500">Branches get a backup ref under refs/pando/backup before deletion.</span>
          <div className="grow" />
          <button onClick={onClose} disabled={busy} className={btn}>{result ? "Close" : "Cancel"}<span className="ml-2 text-xs text-stone-400">Esc</span></button>
          {!result && (
            <button onClick={run} disabled={picked.length === 0 || busy} className="h-8 rounded-lg bg-red-700 px-3.5 font-medium text-white hover:bg-red-800 disabled:opacity-50">
              {busy ? "Removing…" : `Remove ${picked.length} ${picked.length === 1 ? "worktree" : "worktrees"}${totalBytes ? ` · ${bytes(totalBytes)}` : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
