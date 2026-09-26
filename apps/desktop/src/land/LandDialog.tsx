import { useEffect, useState } from "react";
import { api, type LandPlan, type LandResult, type Preflight } from "../lib/api";

type Props = {
  root: string;
  path: string;
  branch: string;
  headSummary?: string | null;
  onClose: () => void;
  onLanded: () => void;
};

const btn = "h-8 rounded-lg border border-stone-300 bg-white px-3 text-[13px] dark:border-stone-600 dark:bg-stone-700";

function Check({ state, children }: { state: "ok" | "warn" | "bad" | "info"; children: React.ReactNode }) {
  const mark = { ok: ["✓", "text-teal-700"], warn: ["!", "text-amber-700"], bad: ["✕", "text-red-700"], info: ["○", "text-stone-500"] }[state];
  return <div className="flex items-start gap-2 text-[13px]"><span className={`w-4 font-semibold ${mark[1]}`}>{mark[0]}</span><span>{children}</span></div>;
}

export function LandDialog({ root, path, branch, headSummary, onClose, onLanded }: Props) {
  const [pf, setPf] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [squash, setSquash] = useState(true);
  const [message, setMessage] = useState("");
  const [destination, setDestination] = useState<LandPlan["destination"]>("local_merge");
  const [pushBase, setPushBase] = useState(true);
  const [runHooks, setRunHooks] = useState(true);
  const [removeWt, setRemoveWt] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LandResult | null>(null);

  useEffect(() => {
    api.landPreflight(root, path, branch, null).then((p) => {
      setPf(p);
      setSquash(p.squash_default);
      setRemoveWt(p.remove_worktree_default);
      setDeleteBranch(p.delete_branch_default);
      setPushBase(p.has_upstream || p.base.includes("/"));
      if (!message) setMessage(p.ahead === 1 && headSummary ? headSummary : `Land ${branch}`);
    }).catch((e) => setError(String(e)));
  }, [root, path, branch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") land();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const canLand = !!pf && pf.problems.length === 0 && !busy && !result;

  async function land() {
    if (!canLand || !pf) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.landRun(root, path, {
        branch, base: pf.base, squash, message: squash ? message : null, destination, push_base: pushBase,
        run_hooks: runHooks, remove_worktree: removeWt, delete_branch: deleteBranch, delete_remote: deleteRemote,
      });
      setResult(r);
      if (r.landed) onLanded();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" className="flex max-h-[90vh] w-[720px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-[13px] shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex flex-col gap-1 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 className="text-base font-semibold">Land <span className="font-mono text-sm">{branch}</span>{pf && <> into <span className="font-mono text-sm">{pf.base}</span></>}</h2>
          {pf && <span className="text-xs text-stone-500">{pf.ahead} {pf.ahead === 1 ? "commit" : "commits"} ahead · {pf.behind} behind{pf.behind > 0 ? ", will rebase first" : ""}</span>}
        </div>

        <div className="flex grow flex-col gap-4 overflow-y-auto p-5">
          {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}

          {!result && (
            <div className="flex flex-col gap-2 rounded-lg border border-stone-300 bg-stone-50 p-3 dark:border-stone-600 dark:bg-stone-900/40">
              <span className="text-xs font-semibold tracking-wider text-stone-500">PREFLIGHT</span>
              {!pf && <span className="text-xs text-stone-500">Checking…</span>}
              {pf && (
                <>
                  <Check state={pf.clean ? "ok" : "bad"}>{pf.clean ? "No uncommitted changes" : "Uncommitted changes in this worktree. Commit or stash first."}</Check>
                  <Check state={pf.ahead > 0 ? "ok" : "bad"}>{pf.ahead > 0 ? `${pf.ahead} ${pf.ahead === 1 ? "commit" : "commits"} to land` : `Nothing ahead of ${pf.base}`}</Check>
                  <Check state={pf.behind === 0 ? "ok" : "warn"}>{pf.behind === 0 ? `Up to date with ${pf.base}` : `${pf.behind} behind ${pf.base}. Will rebase first.`}</Check>
                  <Check state={pf.conflict_predicted ? "bad" : "ok"}>{pf.conflict_predicted ? `Rebase will conflict in ${pf.conflict_files.join(", ")}. Sync and resolve first.` : "Rebase preview: no conflicts"}</Check>
                  {pf.base_checked_out_in && <Check state={pf.base_worktree_clean ? "ok" : "bad"}>{pf.base_worktree_clean ? `${pf.base_local} is checked out and clean` : `The worktree with ${pf.base_local} has uncommitted changes.`}</Check>}
                  {pf.pre_land_hooks.length > 0 && <Check state="info">Before-land hooks will run: <span className="font-mono text-xs">{pf.pre_land_hooks.join(" · ")}</span></Check>}
                  <Check state="info">CI and overlap checks land with the M4 cards.</Check>
                </>
              )}
            </div>
          )}

          {!result && pf && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <fieldset className="flex flex-col gap-2 rounded-lg border border-stone-300 p-3 dark:border-stone-600">
                  <legend className="px-1 text-xs font-semibold tracking-wider text-stone-500">COMMITS</legend>
                  <label className="flex items-center gap-2"><input type="radio" checked={squash} onChange={() => setSquash(true)} /> Squash into one commit</label>
                  <label className="flex items-center gap-2"><input type="radio" checked={!squash} onChange={() => setSquash(false)} /> Keep {pf.ahead} {pf.ahead === 1 ? "commit" : "commits"}</label>
                </fieldset>
                <fieldset className="flex flex-col gap-2 rounded-lg border border-stone-300 p-3 dark:border-stone-600">
                  <legend className="px-1 text-xs font-semibold tracking-wider text-stone-500">DESTINATION</legend>
                  <label className="flex items-center gap-2"><input type="radio" checked={destination === "local_merge"} onChange={() => setDestination("local_merge")} /> Merge into {pf.base_local}</label>
                  {destination === "local_merge" && <label className="ml-5 flex items-center gap-2 text-xs"><input type="checkbox" checked={pushBase} onChange={(e) => setPushBase(e.target.checked)} /> Push {pf.base_local} afterwards</label>}
                  <label className="flex items-center gap-2"><input type="radio" checked={destination === "push_branch"} onChange={() => setDestination("push_branch")} /> Push the branch only</label>
                  <span className="text-xs text-stone-500">Merge via pull request lands with the GitHub card.</span>
                </fieldset>
              </div>

              {squash && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Squash commit message</span>
                  <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} className="w-full resize-none rounded-md border border-stone-300 bg-white p-2 text-[13px] focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
                </label>
              )}

              <fieldset className="flex flex-col gap-2 rounded-lg border border-stone-300 p-3 dark:border-stone-600">
                <legend className="px-1 text-xs font-semibold tracking-wider text-stone-500">AFTER LANDING</legend>
                <label className="flex items-center gap-2"><input type="checkbox" checked={runHooks} onChange={(e) => setRunHooks(e.target.checked)} /> Run before-land and after-land hooks</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={removeWt} onChange={(e) => setRemoveWt(e.target.checked)} /> Remove this worktree</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={deleteBranch} disabled={destination !== "local_merge"} onChange={(e) => setDeleteBranch(e.target.checked)} /> Delete local branch <span className="font-mono text-xs">{branch}</span></label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={deleteRemote} disabled={destination !== "local_merge" || !deleteBranch || !pf.has_upstream} onChange={(e) => setDeleteRemote(e.target.checked)} /> Delete remote branch</label>
              </fieldset>
            </>
          )}

          {result && (
            <div className="flex flex-col gap-2">
              <div className={`rounded-md p-3 text-[13px] font-medium ${result.landed ? "bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200" : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200"}`}>
                {result.landed ? `Landed ${branch}.` : "Land stopped. Nothing after the failed step ran."}
                {result.backup_ref && <span className="ml-2 font-normal text-xs opacity-80">Backup: <span className="font-mono">{result.backup_ref}</span></span>}
              </div>
              {result.steps.map((s, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-md border border-stone-200 p-2 dark:border-stone-700">
                  <div className="flex items-center gap-2"><span className={`font-semibold ${s.ok ? "text-teal-700" : "text-red-700"}`}>{s.ok ? "✓" : "✕"}</span><span>{s.name}</span></div>
                  {s.output.trim() && <pre className="max-h-32 overflow-auto rounded bg-stone-900 p-2 font-mono text-[11px] text-stone-100">{s.output.trim()}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-50 px-5 py-3.5 dark:border-stone-700 dark:bg-stone-900/40">
          <span className="text-xs text-stone-500">{busy ? "Working… conflicts undo the rebase automatically." : "A backup ref is written before anything changes."}</span>
          <div className="grow" />
          <button onClick={onClose} disabled={busy} className={btn}>{result ? "Close" : "Cancel"}<span className="ml-2 text-xs text-stone-400">Esc</span></button>
          {!result && <button onClick={land} disabled={!canLand} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">{busy ? "Landing…" : "Land"}<span className="ml-2 text-xs opacity-70">⌘↵</span></button>}
        </div>
      </div>
    </div>
  );
}
