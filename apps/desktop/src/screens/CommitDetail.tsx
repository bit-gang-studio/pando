import { useEffect, useState } from "react";
import { ago, api, type CommitDiff, type Compare, type FileDiff } from "../lib/api";
import { DiffView } from "./DiffView";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading } from "../ui/State";
import { useArrowKeys } from "../lib/useArrowKeys";

/// One commit's changes, or with `compare` a whole branch against its base
/// (what a pull request shows as "Files changed").
export function CommitDetail({ root, id = "", compare, onBack }: { root: string; id?: string; compare?: { base: string; head: string }; onBack?: () => void }) {
  const [c, setC] = useState<CommitDiff | Compare | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [error, setError] = useState<string | null>(null);
  const split = useSplit("pando.split.commit", 300, "x", 180, 700);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setC(null); setSel(null); setDiff(null); setError(null);
    const load = compare ? api.compare(root, compare.base, compare.head) : api.commitDiff(root, id);
    load.then((x) => { if (live) { setC(x); setSel(x.files[0]?.path ?? null); } }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [root, id, compare?.base, compare?.head, attempt]);

  useEffect(() => {
    if (!sel) { setDiff(null); return; }
    let live = true;
    setLoading(true);
    (compare ? api.compareFileDiff(root, compare.base, compare.head, sel) : api.commitFileDiff(root, id, sel)).then((d) => { if (live) setDiff(d); }).catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [root, id, compare?.base, compare?.head, sel]);

  useEffect(() => {
    if (!onBack) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const files = c?.files ?? [];
  const onListKey = useArrowKeys(files, files.findIndex((f) => f.path === sel), (f) => setSel(f.path));
  if (error) return <ErrorState title={compare ? "Couldn't compare these branches" : "Couldn't load this commit"} error={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!c) return <Loading />;

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4 text-body dark:border-stone-700 dark:bg-stone-800">
        {onBack && <button onClick={onBack} className="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">‹ Back to list</button>}
        {"commit" in c ? (
          <>
            <span className="selectable font-mono" title={c.commit.id}>{c.commit.id.slice(0, 7)}</span>
            <span className="min-w-0 truncate text-stone-500">{c.commit.author} · {ago(c.commit.time)}</span>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate">All changes on <span className="font-mono">{c.head}</span> vs <span className="font-mono">{c.base}</span></span>
            <span className="shrink-0 whitespace-nowrap text-stone-500">{c.ahead} {c.ahead === 1 ? "commit" : "commits"}{c.behind ? ` · ${c.base} is ${c.behind} ahead` : ""}</span>
          </>
        )}
        <span className="shrink-0 whitespace-nowrap text-stone-500">{c.files.length} {c.files.length === 1 ? "file" : "files"}</span>
      </div>
      <div ref={split.box} className="flex min-h-0 min-w-0 grow">
        <aside tabIndex={0} onKeyDown={onListKey} style={{ width: split.size }} className="flex shrink-0 flex-col overflow-y-auto bg-white focus:outline-none dark:bg-stone-800">
          {"message" in c && <pre className="whitespace-pre-wrap border-b border-stone-200 p-3 font-sans text-body dark:border-stone-700">{c.message}</pre>}
          {c.files.length === 0 && <div className="p-3 text-stone-500">No changes.</div>}
          {c.files.map((f) => (
            <button key={f.path} data-selected={sel === f.path} tabIndex={-1} onClick={() => setSel(f.path)} className={`flex items-center gap-2 px-3 py-1.5 text-left ${sel === f.path ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
              <span className="grow truncate font-mono text-body" title={f.path}>{f.path}</span>
              <span className="shrink-0 font-mono text-label text-teal-700">+{f.added}</span>
              <span className="shrink-0 font-mono text-label text-red-700">−{f.deleted}</span>
            </button>
          ))}
        </aside>
        <SplitHandle axis="x" onMouseDown={split.start} handleRef={split.handle} />
        <main className="flex min-w-0 grow flex-col bg-white dark:bg-stone-800">
          <DiffView diff={diff} loading={loading} mode={mode} onMode={setMode} onHunk={() => {}} readOnly />
        </main>
      </div>
    </div>
  );
}
