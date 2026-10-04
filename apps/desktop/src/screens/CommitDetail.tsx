import { useEffect, useState } from "react";
import { ago, api, type CommitDiff, type Compare, type FileDiff, type Range } from "../lib/api";
import { DiffView } from "./DiffView";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading } from "../ui/State";
import { useLayer } from "../lib/keys";
import { useArrowKeys } from "../lib/useArrowKeys";

type Props = {
  root: string;
  id?: string;
  compare?: { base: string; head: string };
  /// Several commits picked together, shown as one diff.
  span?: { older: string; newer: string };
  /// Called with the commits a `span` adds up, once known.
  onRange?: (ids: string[]) => void;
  onPickBase?: (e: React.MouseEvent) => void;
  onBack?: () => void;
};

/// One commit's changes; with `compare` a whole branch against its base
/// (what a pull request shows as "Files changed"); with `span` several commits.
export function CommitDetail({ root, id = "", compare, span, onRange, onPickBase, onBack }: Props) {
  const [c, setC] = useState<CommitDiff | Compare | Range | null>(null);
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
    const load: Promise<CommitDiff | Compare | Range> = span ? api.commitRange(root, span.older, span.newer) : compare ? api.compare(root, compare.base, compare.head) : api.commitDiff(root, id);
    load.then((x) => { if (live) { setC(x); setSel(x.files[0]?.path ?? null); if ("commits" in x) onRange?.(x.commits); } }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, id, compare?.base, compare?.head, span?.older, span?.newer, attempt]);

  useEffect(() => {
    if (!sel) { setDiff(null); return; }
    let live = true;
    setLoading(true);
    const one = c && "commits" in c ? api.commitRangeFileDiff(root, c.base, c.newer, sel) : compare ? api.compareFileDiff(root, compare.base, compare.head, sel) : api.commitFileDiff(root, id, sel);
    one.then((d) => { if (live) setDiff(d); }).catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [root, id, compare?.base, compare?.head, c, sel]);

  useLayer("page", onBack ?? null, !!onBack);

  const files = c?.files ?? [];
  const onListKey = useArrowKeys(files, files.findIndex((f) => f.path === sel), (f) => setSel(f.path));
  if (error) return <ErrorState title={span ? "Couldn't load these commits" : compare ? "Couldn't compare these branches" : "Couldn't load this commit"} error={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!c) return <Loading />;

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4 text-body dark:border-stone-700 dark:bg-stone-800">
        {onBack && <button onClick={onBack} className="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">{span ? "‹ Back to one commit" : "‹ Back to list"}</button>}
        {"commits" in c ? (
          <span className="min-w-0 truncate" title={c.ancestor ? undefined : "Neither commit leads to the other, so this is just what differs between them."}>
            {c.ancestor ? `Changes in ${c.count} commits` : "Difference between 2 commits"}
            <span className="text-stone-500"> · <span className="selectable font-mono">{c.older.slice(0, 7)}</span> to <span className="selectable font-mono">{c.newer.slice(0, 7)}</span>{c.ancestor ? "" : " · on different lines of history"}</span>
          </span>
        ) : "commit" in c ? (
          <>
            <span className="selectable font-mono" title={c.commit.id}>{c.commit.id.slice(0, 7)}</span>
            <span className="min-w-0 truncate text-stone-500">{c.commit.author} · {ago(c.commit.time)}</span>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate">All changes on <span className="font-mono">{c.head}</span> since{" "}
              {onPickBase
                ? <button onClick={onPickBase} title="Compare with another branch" className="font-mono underline decoration-dotted underline-offset-2 hover:text-teal-700">{c.base.replace(/^origin\//, "")}</button>
                : <span className="font-mono">{c.base.replace(/^origin\//, "")}</span>}
            </span>
            <span className="shrink-0 whitespace-nowrap text-stone-500">{c.ahead} {c.ahead === 1 ? "commit" : "commits"}{c.behind ? ` · ${c.base.replace(/^origin\//, "")} has ${c.behind} newer` : ""}</span>
          </>
        )}
        <span className="shrink-0 whitespace-nowrap text-stone-500">{c.files.length} {c.files.length === 1 ? "file" : "files"}</span>
        <LineTotals added={"added" in c ? c.added : c.files.reduce((n, f) => n + f.added, 0)} deleted={"deleted" in c ? c.deleted : c.files.reduce((n, f) => n + f.deleted, 0)} />
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

/// "+12,480 −3,210" for a commit or a branch.
function LineTotals({ added, deleted }: { added: number; deleted: number }) {
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-label" title={`${n(added)} lines added, ${n(deleted)} removed`}>
      <span className="text-teal-700">+{n(added)}</span> <span className="text-red-700">−{n(deleted)}</span>
    </span>
  );
}
