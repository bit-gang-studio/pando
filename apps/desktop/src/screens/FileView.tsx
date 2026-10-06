import { useEffect, useRef, useState } from "react";
import { ago, api, type Blame, type FileCommit, type FileDiff } from "../lib/api";
import { DiffView } from "./DiffView";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading } from "../ui/State";
import { useLayer } from "../lib/keys";
import { useArrowKeys } from "../lib/useArrowKeys";

export type FileTarget = {
  path: string;
  /// The commit or branch to read the file at. Null means the working copy.
  rev: string | null;
  /// For the working copy: which worktree's.
  worktree: string | null;
  mode: "history" | "blame";
};
type Props = { root: string; target: FileTarget; onMode: (m: FileTarget["mode"]) => void; onBack: () => void; onOpenCommit: (id: string) => void };

const PAGE = 100;
const CHANGE: Record<string, string> = { A: "added", D: "deleted", R: "renamed", C: "copied" };

/// One file over time: the commits that changed it, or who last changed each line.
export function FileView({ root, target, onMode, onBack, onOpenCommit }: Props) {
  useLayer("page", onBack);
  const tab = (m: FileTarget["mode"], label: string) => (
    <button onClick={() => onMode(m)} aria-pressed={target.mode === m} className={`h-6 rounded px-2 text-label ${target.mode === m ? "bg-stone-200 font-medium dark:bg-stone-600" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>{label}</button>
  );
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4 text-body dark:border-stone-700 dark:bg-stone-800">
        <button onClick={onBack} className="shrink-0 text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">‹ Back</button>
        <span className="selectable min-w-0 truncate font-mono" title={target.path}>{target.path}</span>
        <span className="shrink-0 whitespace-nowrap text-stone-500">{target.rev ? `at ${/^[0-9a-f]{40}$/.test(target.rev) ? target.rev.slice(0, 7) : target.rev}` : "working copy"}</span>
        <div className="grow" />
        <div className="flex shrink-0 gap-1 rounded-md border border-stone-300 p-0.5 dark:border-stone-600">{tab("history", "History")}{tab("blame", "Blame")}</div>
      </div>
      {target.mode === "history"
        ? <History key={`h-${target.path}-${target.rev}`} root={root} target={target} onOpenCommit={onOpenCommit} />
        : <BlameList key={`b-${target.path}-${target.rev}-${target.worktree}`} root={root} target={target} onOpenCommit={onOpenCommit} />}
    </div>
  );
}

function History({ root, target, onOpenCommit }: { root: string; target: FileTarget; onOpenCommit: (id: string) => void }) {
  const [commits, setCommits] = useState<FileCommit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const split = useSplit("pando.split.commit", 300, "x", 180, 700);

  useEffect(() => {
    let live = true;
    setCommits(null); setError(null);
    api.fileHistory(root, target.rev, target.path, 0, PAGE)
      .then((h) => { if (live) { setCommits(h.commits); setTruncated(h.truncated); setSel(h.commits[0]?.entry.id ?? null); } })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [root, target.rev, target.path, attempt]);

  const picked = commits?.find((c) => c.entry.id === sel) ?? null;
  useEffect(() => {
    if (!picked) { setDiff(null); return; }
    let live = true;
    setLoading(true);
    // The file may have had another name back then.
    api.commitFileDiff(root, picked.entry.id, picked.path).then((d) => { if (live) setDiff(d); }).catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, picked?.entry.id, picked?.path]);

  async function loadMore() {
    if (more || !commits) return;
    setMore(true);
    try {
      const h = await api.fileHistory(root, target.rev, target.path, commits.length, PAGE);
      const seen = new Set(commits.map((c) => c.entry.id));
      setCommits([...commits, ...h.commits.filter((c) => !seen.has(c.entry.id))]);
      setTruncated(h.truncated);
    } catch (e) { setError(String(e)); } finally { setMore(false); }
  }

  const list = commits ?? [];
  const onListKey = useArrowKeys(list, list.findIndex((c) => c.entry.id === sel), (c) => setSel(c.entry.id));
  if (error) return <ErrorState title="Couldn't load this file's history" error={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!commits) return <Loading />;
  if (commits.length === 0) return <div className="flex grow items-center justify-center text-body text-stone-500">No commits have changed this file.</div>;

  return (
    <div ref={split.box} className="flex min-h-0 min-w-0 grow">
      <aside tabIndex={0} onKeyDown={onListKey} style={{ width: split.size }} className="flex shrink-0 flex-col overflow-y-auto bg-white focus:outline-none dark:bg-stone-800">
        <div className="px-3 py-1.5 text-label text-stone-500">{commits.length}{truncated ? "+" : ""} {commits.length === 1 && !truncated ? "commit" : "commits"} changed this file</div>
        {commits.map((c) => (
          <button key={c.entry.id} data-selected={sel === c.entry.id} tabIndex={-1} onClick={() => setSel(c.entry.id)} onDoubleClick={() => onOpenCommit(c.entry.id)} title="Double-click to open the whole commit" className={`flex flex-col gap-0.5 px-3 py-1.5 text-left ${sel === c.entry.id ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="truncate">{c.entry.summary}</span>
            <span className="truncate text-label text-stone-500">
              <span className="font-mono">{c.entry.id.slice(0, 7)}</span> · {c.entry.author} · {ago(c.entry.time)}
              {CHANGE[c.change] ? ` · ${CHANGE[c.change]}` : ""}{c.path !== target.path ? <> · as <span className="font-mono">{c.path}</span></> : null}
            </span>
          </button>
        ))}
        {truncated && <button onClick={loadMore} disabled={more} className="m-2 rounded-md border border-stone-300 bg-white px-3 py-1 text-body disabled:opacity-50 dark:border-stone-600 dark:bg-stone-700">{more ? "Loading…" : `Load ${PAGE} more`}</button>}
      </aside>
      <SplitHandle axis="x" onMouseDown={split.start} handleRef={split.handle} />
      <main className="flex min-w-0 grow flex-col bg-white dark:bg-stone-800">
        <DiffView diff={diff} loading={loading} mode={mode} onMode={setMode} onHunk={() => {}} readOnly />
      </main>
    </div>
  );
}

const ROW = 20;

function BlameList({ root, target, onOpenCommit }: { root: string; target: FileTarget; onOpenCommit: (id: string) => void }) {
  const [b, setB] = useState<Blame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setB(null); setError(null);
    api.fileBlame(root, target.worktree, target.rev, target.path).then((x) => { if (live) setB(x); }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [root, target.worktree, target.rev, target.path, attempt]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setHeight(el.clientHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [b]);

  if (error) return <ErrorState title="Couldn't blame this file" error={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!b) return <Loading />;
  if (b.lines.length === 0) return <div className="flex grow items-center justify-center text-body text-stone-500">This file is empty.</div>;

  // Only the rows on screen are drawn: a file can have tens of thousands of lines.
  const from = Math.max(0, Math.floor(top / ROW) - 20);
  const to = Math.min(b.lines.length, Math.ceil((top + height) / ROW) + 20);
  const digits = String(b.lines.length).length;
  return (
    <div ref={box} onScroll={(e) => setTop(e.currentTarget.scrollTop)} className="min-h-0 grow overflow-auto bg-white font-mono text-label dark:bg-stone-800" role="table" aria-label={`Blame for ${b.path}`} aria-rowcount={b.lines.length}>
      <div style={{ height: b.lines.length * ROW, position: "relative", minWidth: "max-content" }}>
        {b.lines.slice(from, to).map((l, k) => {
          const i = from + k;
          const c = l.commit ? b.commits[l.commit] : null;
          // Name the commit on the first line of each run, and on the first row drawn.
          const first = i === 0 || b.lines[i - 1].commit !== l.commit;
          const label = first || k === 0;
          return (
            <div key={i} role="row" aria-rowindex={i + 1} data-line={i + 1} style={{ position: "absolute", top: i * ROW, height: ROW, left: 0, right: 0 }} className={`flex items-center ${first && i > 0 ? "border-t border-stone-200 dark:border-stone-700" : ""}`}>
              <button
                disabled={!c}
                onClick={() => l.commit && onOpenCommit(l.commit)}
                title={c ? `${c.summary}\n${c.author} · ${new Date(c.time * 1000).toLocaleString()}${c.path !== b.path ? `\nas ${c.path}` : ""}` : "Not committed yet"}
                className="flex h-full w-72 shrink-0 items-center gap-2 overflow-hidden border-r border-stone-200 bg-stone-50 px-2 text-left font-sans hover:bg-stone-100 disabled:hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900/40 dark:hover:bg-stone-700"
              >
                {label && (c ? (
                  <>
                    <span className="shrink-0 font-mono text-stone-500">{l.commit.slice(0, 7)}</span>
                    <span className="min-w-0 grow truncate">{c.summary}</span>
                    <span className="shrink-0 text-stone-500">{c.author.split(" ")[0]} · {ago(c.time)}</span>
                  </>
                ) : <span className="italic text-amber-700 dark:text-amber-400">Not committed yet</span>)}
              </button>
              <span className="w-12 shrink-0 select-none px-2 text-right text-stone-400" style={{ minWidth: `${digits + 2}ch` }}>{i + 1}</span>
              <span className="selectable whitespace-pre pr-4">{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
