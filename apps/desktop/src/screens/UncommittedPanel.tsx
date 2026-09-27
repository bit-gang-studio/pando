import { useEffect, useState } from "react";
import { api, type Detail, type FileDiff, type FileStatus } from "../lib/api";
import { navigate } from "../lib/routes";
import { SplitHandle, useSplit } from "../ui/Split";
import { DiffView } from "./DiffView";
import { ErrorState, Loading } from "../ui/State";
import { errorParts } from "../lib/errors";

const STATUS_LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", "?": "Untracked (new, not tracked by git yet)" };
type Sel = { path: string; file: FileStatus } | null;

/// Uncommitted changes across every worktree of a repo, read-only.
/// `refreshKey` changes whenever the repo page refreshes, so file lists stay current.
export function UncommittedPanel({ root, worktrees, refreshKey = 0 }: { root: string; worktrees: string[]; refreshKey?: number }) {
  const [details, setDetails] = useState<Detail[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sel, setSel] = useState<Sel>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [error, setError] = useState<string | null>(null);
  const split = useSplit("pando.split.uncommitted.px", 320, "x", 200, 700);

  useEffect(() => {
    let live = true;
    Promise.all(worktrees.map((p) => api.detail(root, p))).then((ds) => {
      if (!live) return;
      setDetails(ds);
      setSel((s) => {
        if (s && ds.some((d) => d.worktree.path === s.path && d.files.some((f) => f.path === s.file.path))) return { ...s }; // new object: reload its diff too
        const first = ds.find((d) => d.files.length > 0);
        return first ? { path: first.worktree.path, file: first.files[0] } : null;
      });
      setError(null);
    }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [root, worktrees.join("\0"), attempt, refreshKey]);

  useEffect(() => {
    if (!sel) { setDiff(null); return; }
    let live = true;
    setLoading(true);
    const f = sel.file;
    // Show the working copy against HEAD: staged part first if that's all there is.
    api.diffFile(sel.path, f.path, !f.unstaged && !f.untracked && !!f.staged, f.untracked)
      .then((d) => { if (live) setDiff(d); })
      .catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sel]);

  if (!details) return error ? <ErrorState title="Couldn't load uncommitted changes" error={error} onRetry={() => setAttempt((n) => n + 1)} /> : <Loading />;

  return (
    <div ref={split.box} className="flex min-h-0 grow">
      <aside style={{ width: split.size }} className="flex shrink-0 flex-col overflow-y-auto bg-white dark:bg-stone-800">
        {error && <div className="selectable p-2 text-body text-red-700">{errorParts(error).message}</div>}
        {details.map((d) => (
          <div key={d.worktree.path} className="border-b border-stone-200 dark:border-stone-700">
            <div className="flex items-center gap-2 px-3 pb-1 pt-2">
              <span className="truncate font-mono text-body font-medium" title={d.worktree.path}>{d.worktree.branch ?? `detached at ${d.worktree.head?.slice(0, 7)}`}</span>
              <span className="shrink-0 whitespace-nowrap text-label text-stone-500">{d.files.length} {d.files.length === 1 ? "file" : "files"}</span>
              <div className="grow" />
              <button onClick={() => navigate({ kind: "worktree", root, path: d.worktree.path })} className="text-label text-teal-700 hover:underline">Open worktree</button>
            </div>
            {d.files.map((f) => {
              const active = sel?.path === d.worktree.path && sel.file.path === f.path;
              const code = f.conflicted ? "U" : f.untracked ? "?" : f.unstaged ?? f.staged ?? "";
              return (
                <button key={f.path} onClick={() => setSel({ path: d.worktree.path, file: f })} className={`flex w-full items-center gap-2 px-3 py-1 text-left ${active ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
                  <span title={STATUS_LABEL[String(f.conflicted ? "U" : code)] ?? ""} className={`w-3 shrink-0 cursor-help text-center font-mono text-label ${f.conflicted ? "text-red-700" : "text-stone-500"}`}>{code}</span>
                  <span className="min-w-0 grow truncate font-mono text-body" title={f.path}>{f.path}</span>
                  {f.staged && f.unstaged && <span className="shrink-0 whitespace-nowrap text-label text-stone-400">partly staged</span>}
                  {f.staged && !f.unstaged && !f.untracked && <span className="shrink-0 whitespace-nowrap text-label text-stone-400">staged</span>}
                </button>
              );
            })}
          </div>
        ))}
        {details.length > 0 && details.every((d) => d.files.length === 0) && <div className="p-3 text-body text-stone-500">Nothing uncommitted.</div>}
      </aside>
      <SplitHandle axis="x" onMouseDown={split.start} handleRef={split.handle} />
      <main className="flex min-w-0 grow flex-col bg-white dark:bg-stone-800">
        <DiffView diff={diff} loading={loading} mode={mode} onMode={setMode} onHunk={() => {}} readOnly />
      </main>
    </div>
  );
}

