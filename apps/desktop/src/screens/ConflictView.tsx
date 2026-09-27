import { useEffect, useState } from "react";
import { api, type ConflictFile, type Operation } from "../lib/api";

type Props = {
  worktree: string;
  path: string;
  op: Operation;
  onChanged: () => void;
};

const btn = "h-6.5 rounded border border-stone-300 bg-white px-2 text-label hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";

export function ConflictView({ worktree, path, op, onChanged }: Props) {
  const [f, setF] = useState<ConflictFile | null>(null);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.conflictFile(worktree, path).then((x) => { setF(x); setResult(x.working); }).catch((e) => setError(String(e)));
  useEffect(() => { setF(null); load(); }, [worktree, path]);

  async function run(fn: () => Promise<unknown>, reload = true) {
    setBusy(true);
    setError(null);
    try { await fn(); if (reload) await load(); onChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  if (!f) return <div className="flex grow items-center justify-center text-body text-stone-500">{error ?? "Loading…"}</div>;
  if (f.binary) return <div className="flex grow flex-col items-center justify-center gap-2 text-body text-stone-500">Binary file. Pick a side.<div className="flex gap-2"><button onClick={() => run(() => api.conflictTake(worktree, path, "ours"))} className={btn}>Keep {op.head_label}</button><button onClick={() => run(() => api.conflictTake(worktree, path, "theirs"))} className={btn}>Keep {op.incoming_label}</button></div></div>;

  const stillConflicted = op.conflicted.includes(path);
  const hasMarkers = /^<<<<<<< /m.test(result);

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-stone-300 px-4 dark:border-stone-700">
        <span className="font-mono text-body font-medium">{path}</span>
        <span className="text-label text-stone-500">{stillConflicted ? "conflicted" : "resolved"}</span>
        <div className="grow" />
        <button onClick={() => run(() => api.conflictReset(worktree, path))} disabled={busy || stillConflicted} className={btn}>Back to conflicted</button>
        <button onClick={() => run(() => api.conflictResolve(worktree, path, result))} disabled={busy || hasMarkers} className="h-6.5 rounded bg-teal-700 px-2.5 text-label font-medium text-white disabled:opacity-40" title={hasMarkers ? "Remove the conflict markers first" : "Save and mark resolved"}>
          Mark resolved
        </button>
      </div>
      {error && <div className="bg-red-50 px-4 py-1.5 text-body text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}

      <div className="grid min-h-0 grow grid-cols-2 divide-x divide-stone-300 border-b border-stone-300 dark:divide-stone-700 dark:border-stone-700">
        <Pane label={op.head_label} hint="already there" text={f.ours} onTake={() => run(() => api.conflictTake(worktree, path, "ours"))} busy={busy} />
        <Pane label={op.incoming_label} hint="coming in" text={f.theirs} onTake={() => run(() => api.conflictTake(worktree, path, "theirs"))} busy={busy} />
      </div>

      <div className="flex h-[38%] shrink-0 flex-col">
        <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-100 px-3 py-1 text-body dark:border-stone-700 dark:bg-stone-800/80">
          <span className="font-semibold">Result</span>
          <span className="text-stone-500">edit here, then Mark resolved</span>
          <div className="grow" />
          <button onClick={() => run(() => api.conflictTake(worktree, path, "both"))} disabled={busy} className={btn}>Take both</button>
          <button onClick={() => setResult(f.working)} disabled={busy} className={btn}>Reload file</button>
        </div>
        <textarea value={result} onChange={(e) => setResult(e.target.value)} spellCheck={false} className="min-h-0 grow resize-none bg-white p-3 font-mono text-body leading-5 focus:outline-none dark:bg-stone-800" />
      </div>
    </div>
  );
}

function Pane({ label, hint, text, onTake, busy }: { label: string; hint: string; text: string; onTake: () => void; busy: boolean }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-100 px-3 py-1 text-body dark:border-stone-700 dark:bg-stone-800/80">
        <span className="truncate font-semibold">{label}</span>
        <span className="text-stone-500">· {hint}</span>
        <div className="grow" />
        <button onClick={onTake} disabled={busy} className={btn}>Take this</button>
      </div>
      <pre className="min-h-0 grow overflow-auto p-3 font-mono text-body leading-5">{text || <span className="text-stone-400">(empty or deleted)</span>}</pre>
    </div>
  );
}
