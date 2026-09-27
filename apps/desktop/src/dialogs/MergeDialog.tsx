import { useEffect, useState } from "react";
import { api, type MergePlan, type MergeResult, type Preflight } from "../lib/api";

type Props = {
  root: string;
  path: string;
  branch: string;
  headSummary?: string | null;
  onClose: () => void;
  onMerged: () => void;
};

type Strategy = MergePlan["strategy"];
const STRATEGIES: { id: Strategy; label: string; hint: string }[] = [
  { id: "merge_commit", label: "Create a merge commit", hint: "Keeps every commit and adds a merge commit." },
  { id: "squash", label: "Squash and merge", hint: "One new commit with all the changes." },
  { id: "rebase", label: "Rebase and merge", hint: "Replays each commit on top, no merge commit." },
];
const LAST_KEY = "pando.mergeStrategy";

const btn = "h-8 rounded-lg border border-stone-300 bg-white px-3 text-body dark:border-stone-600 dark:bg-stone-700";

export function MergeDialog({ root, path, branch, headSummary, onClose, onMerged }: Props) {
  const [pf, setPf] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy>(() => {
    try { return (localStorage.getItem(LAST_KEY) as Strategy) || "squash"; } catch { return "squash"; }
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);

  useEffect(() => {
    api.mergePreflight(root, path, branch).then((p) => {
      setPf(p);
      setMessage((m) => m || p.last_summary || headSummary || "");
    }).catch((e) => setError(String(e)));
  }, [root, path, branch, headSummary]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") merge();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const blocked = !!pf && pf.problems.length > 0;
  const canMerge = !!pf && !blocked && !busy && !result && (strategy === "rebase" || message.trim().length > 0);

  async function merge() {
    if (!canMerge || !pf) return;
    setBusy(true);
    setError(null);
    try { localStorage.setItem(LAST_KEY, strategy); } catch { /* ignore */ }
    try {
      const r = await api.mergeRun(root, path, {
        branch, base: pf.base, strategy, message: strategy === "rebase" ? null : message.trim(),
        push_base: false, delete_branch: false,
      });
      setResult(r);
      if (r.landed) onMerged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = pf
    ? [
        `${pf.ahead} ${pf.ahead === 1 ? "commit" : "commits"}`,
        pf.behind > 0 ? `${pf.base_local} moved ${pf.behind} ahead` : `up to date with ${pf.base_local}`,
        pf.conflict_predicted ? "conflicts" : "no conflicts",
      ].join(" · ")
    : "Checking…";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" className="flex max-h-[90vh] w-[560px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-body shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex flex-col gap-1 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 className="text-title font-semibold">Merge <span className="font-mono">{branch}</span> into <span className="font-mono">{pf?.base_local ?? "…"}</span></h2>
          <span className="text-body text-stone-500">{summary}</span>
        </div>

        <div className="flex grow flex-col gap-4 overflow-y-auto p-5">
          {error && <div className="selectable rounded-md border border-red-300 bg-red-50 p-2 text-body text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}

          {!result && pf && blocked && (
            <div className="flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 p-3 text-red-800 dark:bg-red-900/30 dark:text-red-200">
              {pf.problems.map((p, i) => <div key={i} className="flex gap-2"><span className="font-semibold">✕</span><span>{p}</span></div>)}
            </div>
          )}

          {!result && pf && (
            <>
              <fieldset className="flex flex-col gap-2">
                {STRATEGIES.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-start gap-2">
                    <input type="radio" name="strategy" checked={strategy === s.id} onChange={() => setStrategy(s.id)} className="mt-0.5" />
                    <span className="flex flex-col"><span>{s.label}</span><span className="text-body text-stone-500">{s.hint}</span></span>
                  </label>
                ))}
              </fieldset>

              {strategy !== "rebase" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-body font-medium text-stone-600 dark:text-stone-300">Message</span>
                  <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className="w-full resize-none rounded-md border border-stone-300 bg-white p-2 text-body focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
                </label>
              )}
            </>
          )}

          {result && (
            <div className="flex flex-col gap-2">
              <div className={`rounded-md p-3 font-medium ${result.landed ? "bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200" : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200"}`}>
                {result.landed ? `Merged ${branch} into ${pf?.base_local}.` : "Merge stopped. Nothing after the failed step ran."}
              </div>
              {result.steps.map((s, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-md border border-stone-200 p-2 dark:border-stone-700">
                  <div className="flex items-center gap-2"><span className={`font-semibold ${s.ok ? "text-teal-700" : "text-red-700"}`}>{s.ok ? "✓" : "✕"}</span><span>{s.name}</span></div>
                  {s.output.trim() && <pre className="max-h-32 overflow-auto rounded bg-stone-900 p-2 font-mono text-label text-stone-100">{s.output.trim()}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-300 bg-stone-50 px-5 py-3.5 dark:border-stone-700 dark:bg-stone-900/40">
          <button onClick={onClose} disabled={busy} className={btn}>{result ? "Close" : "Cancel"}<span className="ml-2 text-body text-stone-400">Esc</span></button>
          {!result && <button onClick={merge} disabled={!canMerge} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">{busy ? "Merging…" : "Merge"}<span className="ml-2 text-body opacity-70">⌘↵</span></button>}
        </div>
      </div>
    </div>
  );
}
