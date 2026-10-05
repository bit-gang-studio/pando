import { useCallback, useEffect, useRef, useState } from "react";
import { ago, api, type Detail as DetailData, type FileDiff, type FileStatus, type Hunk } from "../lib/api";
import { Chip } from "../ui/Chip";
import { DiffView } from "./DiffView";
import { ConflictView } from "./ConflictView";
import { SplitHandle, useSplit } from "../ui/Split";
import { MergeDialog } from "../dialogs/MergeDialog";
import { confirm } from "../ui/Confirm";
import { toastDone } from "../ui/Toast";
import { ErrorState, Loading } from "../ui/State";
import { errorParts } from "../lib/errors";
import { useRepoRefresh } from "../lib/watch";
import { overlayOpen, useLayer } from "../lib/keys";
import { useArrowKeys } from "../lib/useArrowKeys";
import { forcePush } from "../lib/forcePush";

const STATUS_LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflict", "?": "Untracked (new, not tracked by git yet)" };
type Props = { root: string; path: string; onBack: () => void; onChanged: () => void; /** Set when this branch can get a pull request. */ onCreatePr?: () => void };
type Sel = { path: string; staged: boolean; untracked: boolean } | null;

const btn = "h-8 rounded-lg border border-stone-300 bg-white px-3 text-body hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const small = "h-5.5 rounded border border-stone-300 bg-white px-2 text-label dark:border-stone-600 dark:bg-stone-700";

export function Detail({ root, path, onBack, onChanged, onCreatePr }: Props) {
  const [d, setD] = useState<DetailData | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [message, setMessage] = useState(""); // the summary line
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const msgRef = useRef<HTMLInputElement>(null);
  const [merging, setMerging] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const split = useSplit("pando.split.worktree", 300, "x", 200, 700);

  const refresh = useCallback(async () => {
    try {
      const next = await api.detail(root, path);
      setD(next);
      setError(null);
      setSel((s) => {
        if (next.operation && s && (next.operation.conflicted.includes(s.path) || next.operation.resolved.includes(s.path))) return s;
        if (next.operation && next.operation.conflicted.length > 0) return { path: next.operation.conflicted[0], staged: false, untracked: false };
        if (s && next.files.some((f) => f.path === s.path && (s.staged ? !!f.staged : !!f.unstaged || f.untracked))) return s;
        const first = next.files.find((f) => f.unstaged || f.untracked) ?? next.files.find((f) => f.staged);
        return first ? { path: first.path, staged: !first.unstaged && !first.untracked && !!first.staged, untracked: first.untracked } : null;
      });
    } catch (e) {
      setError(String(e));
    }
  }, [root, path]);

  useRepoRefresh(root, refresh);

  useEffect(() => {
    if (!d || !sel) { setDiff(null); return; }
    let live = true;
    setDiffLoading(true);
    api.diffFile(d.worktree.path, sel.path, sel.staged, sel.untracked)
      .then((x) => { if (live) setDiff(x); })
      .catch((e) => setError(String(e)))
      .finally(() => { if (live) setDiffLoading(false); });
    return () => { live = false; };
  }, [d, sel]);

  useLayer("page", onBack);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog, confirm or menu is open: its keys are its own.
      if (overlayOpen()) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doCommit(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l" && d && d.worktree.kind === "linked" && d.worktree.branch) { e.preventDefault(); setMerging(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /// Returns true if the action worked.
  async function run(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(label);
    setError(null);
    try { await fn(); await refresh(); onChanged(); return true; }
    catch (e) { setError(String(e)); return false; }
    finally { setBusy(null); }
  }

  const opFiles = d?.operation ? [...d.operation.conflicted, ...d.operation.resolved_by_you].map((p) => ({ path: p, staged: false, untracked: false })) : [];
  const navFiles = d?.operation ? opFiles : d ? [
    ...d.files.filter((f) => f.unstaged || f.untracked).map((f) => ({ path: f.path, staged: false, untracked: f.untracked })),
    ...d.files.filter((f) => f.staged).map((f) => ({ path: f.path, staged: true, untracked: false })),
  ] : [];
  const onListKey = useArrowKeys(navFiles, navFiles.findIndex((x) => x.path === sel?.path && x.staged === sel?.staged), setSel);
  if (!d) return error ? <ErrorState title="Couldn't load this worktree" error={error} onRetry={refresh} /> : <Loading />;

  const wt = d.worktree.path;
  const op = d.operation;
  // During a merge or rebase, conflicts and resolved files have their own lists.
  const unstaged = d.files.filter((f) => (f.unstaged || f.untracked) && !(op && f.conflicted));
  const staged = op ? [] : d.files.filter((f) => f.staged);
  const auto = op ? op.resolved.filter((p) => !op.resolved_by_you.includes(p)) : [];
  const nextConflicted = () => {
    if (!op || op.conflicted.length === 0) return;
    const later = op.conflicted.find((p) => sel && p > sel.path);
    setSel({ path: later ?? op.conflicted[0], staged: false, untracked: false });
  };
  const conflicts = d.files.filter((f) => f.conflicted).length;
  const b = d.branch;
  const isMain = d.worktree.kind === "main";
  const canCommit = (staged.length > 0 || amend) && message.trim().length > 0 && !busy && !d.operation;

  async function doCommit() {
    if (!canCommit) return;
    // Keep what they typed if the commit fails (hook, signing, lock).
    // Git's shape: summary, a blank line, then the description.
    const full = description.trim() ? `${message.trim()}\n\n${description.trim()}` : message.trim();
    if (!(await run("commit", () => api.commitCreate(wt, full, amend)))) return;
    setMessage("");
    setDescription("");
    setAmend(false);
  }

  async function discard(f: FileStatus) {
    const r = await confirm(f.untracked
      ? { title: "Delete file", body: <>Delete the new file <span className="font-mono">{f.path}</span>? You can undo this.</>, action: "Delete file", danger: true }
      : { title: "Discard changes", body: <>Throw away the unstaged changes in <span className="font-mono">{f.path}</span>? You can undo this.</>, action: "Discard changes", danger: true });
    if (!r.ok) return;
    let snap: string | null = null;
    const ok = await run("discard", async () => { snap = await api.discardPaths(wt, f.untracked ? [] : [f.path], f.untracked ? [f.path] : []); });
    const saved = snap as string | null;
    if (ok && saved) toastDone(f.untracked ? `Deleted ${f.path}` : `Discarded changes in ${f.path}`, { run: () => api.backupRestoreFiles(root, saved, wt), after: refresh });
  }

  async function hunk(h: Hunk, reverse: boolean) {
    if (!diff) return;
    await run("hunk", () => api.applyHunk(wt, diff.path, h, reverse));
  }

  async function lines(h: Hunk, picked: number[], reverse: boolean) {
    if (!diff) return;
    await run("lines", () => api.applyLines(wt, diff.path, h, picked, reverse));
  }

  async function syncNow() {
    if (!d || !b || !d.base_branch) return;
    const base = b.upstream && b.name === d.base_branch ? b.upstream : d.base_branch;
    if (unstaged.length + staged.length > 0) {
      setError("Commit or stash your changes before syncing.");
      return;
    }
    await run("sync", async () => {
      const r = await api.syncRebase(root, wt, b.name, base);
      if (r.ok) setNotice(r.message);
      else setNotice(r.message);
    });
  }

  const fileRow = (f: FileStatus, stagedSide: boolean) => {
    const active = sel?.path === f.path && sel.staged === stagedSide;
    const code = stagedSide ? f.staged : f.untracked ? "?" : f.unstaged;
    return (
      <div key={`${stagedSide}-${f.path}`} data-selected={active} onClick={() => setSel({ path: f.path, staged: stagedSide, untracked: f.untracked })} className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${active ? "bg-teal-100 dark:bg-teal-900/40" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
        <input type="checkbox" checked={stagedSide} onChange={() => run("stage", () => (stagedSide ? api.unstagePaths(wt, [f.path]) : api.stagePaths(wt, [f.path])))} onClick={(e) => e.stopPropagation()} aria-label={stagedSide ? `Unstage ${f.path}` : `Stage ${f.path}`} className="m-0" />
        <span title={STATUS_LABEL[String(f.conflicted ? "U" : code)] ?? ""} className={`w-3 shrink-0 cursor-help text-center font-mono text-label ${f.conflicted ? "text-red-700" : "text-stone-500"}`}>{f.conflicted ? "U" : code}</span>
        <span className="min-w-0 grow truncate font-mono text-body" title={f.path}>{f.path}</span>
        {!stagedSide && <button onClick={(e) => { e.stopPropagation(); discard(f); }} className={`${small} invisible text-red-700 group-hover:visible`}>Discard</button>}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col">
      {merging && d.worktree.branch && (
        <MergeDialog root={root} path={wt} branch={d.worktree.branch} headSummary={d.head_summary} onClose={() => setMerging(false)} onMerged={() => { onChanged(); onBack(); }} />
      )}
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-stone-300 bg-white px-4 dark:border-stone-700 dark:bg-stone-800">
        <span className="font-mono text-body font-medium">{d.worktree.branch ?? "(detached)"}</span>
        {isMain && <Chip>main worktree</Chip>}
        {!op && (d.files.length > 0 ? <Chip tone="amber">{d.files.length} changed</Chip> : <Chip>clean</Chip>)}
        {!op && conflicts > 0 && <Chip tone="red">{conflicts} conflicts</Chip>}
        <div className="grow" />
        {b && !d.operation && (() => {
          // One button, the next thing to do: pull first if the remote moved, else push.
          const up = b.ahead ?? 0, down = b.behind ?? 0;
          const pull = async () => { if (await run("pull", () => api.branchPull(wt))) toastDone(`Pulled ${b.name}`); };
          const push = async () => { if (await run("push", () => api.branchPush(root, b.name))) toastDone(`Pushed ${b.name}`); };
          if (!b.upstream) return <button onClick={push} disabled={!!busy} className={btn} title="Push this branch to origin and track it">{busy === "push" ? "Pushing…" : "Push to origin"}</button>;
          // Rewritten here (reword, squash, drop, amend): pulling would bring the old commits back.
          if (b.upstream_rewritten) return <button onClick={async () => { if (await forcePush(root, b)) { await refresh(); onChanged(); } }} disabled={!!busy} className={btn} title={`You rewrote commits that are on ${b.upstream}. Force push to update it.`}>Force push…</button>;
          if (down > 0) return <button onClick={pull} disabled={!!busy} className={btn} title={up ? `${down} to pull, then ${up} to push (${b.upstream})` : `${down} to pull (${b.upstream})`}>{busy === "pull" ? "Pulling…" : `Pull ↓${down}`}</button>;
          if (up > 0) return <button onClick={push} disabled={!!busy} className={btn} title={`${up} to push (${b.upstream})`}>{busy === "push" ? "Pushing…" : `Push ↑${up}`}</button>;
          return <span className="text-label text-stone-500" title={b.upstream}>Up to date</span>;
        })()}
        {b?.upstream && !b.upstream_rewritten && !d.operation && onCreatePr && <button onClick={onCreatePr} disabled={!!busy} className={btn}>Create pull request…</button>}
        {!isMain && d.base_branch && !d.operation && <button onClick={syncNow} disabled={!!busy} className={btn}>{busy === "sync" ? "Syncing…" : `Sync with ${d.base_branch}`}</button>}
        {!isMain && !op && <button onClick={() => setMerging(true)} disabled={!d.worktree.branch || !!d.operation} className="h-8 rounded-lg bg-teal-700 px-3.5 text-body font-medium text-white hover:bg-teal-800 disabled:opacity-40">Merge <span className="text-body opacity-70">⌘L</span></button>}
      </div>

      {d.operation && (
        <div className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-body dark:border-amber-800 dark:bg-amber-900/30">
          <span className="h-2 w-2 rounded-full bg-amber-700" />
          <span className="font-semibold text-amber-800 dark:text-amber-200">
            {d.operation.kind === "rebase" ? `Rebasing ${d.operation.incoming_label} onto ${d.operation.head_label}` : d.operation.kind === "merge" ? `Merging ${d.operation.incoming_label} into ${d.operation.head_label}` : d.operation.kind === "revert" ? `Reverting ${d.operation.incoming_label}` : `Cherry-picking ${d.operation.incoming_label}`}
            {d.operation.total > 0 && ` · commit ${d.operation.applied} of ${d.operation.total}`}
          </span>
          <span className="text-stone-600 dark:text-stone-300">{d.operation.conflicted.length > 0 ? `${d.operation.conflicted.length} ${d.operation.conflicted.length === 1 ? "file" : "files"} left` : "All conflicts resolved"}</span>
          <div className="grow" />
          <button onClick={() => run("abort", async () => { if ((await confirm({ title: "Abort", body: "Stop and put the branch back exactly as it was before?", action: "Abort", danger: true })).ok) await api.opAbort(wt); })} disabled={!!busy} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-red-700 dark:border-stone-600 dark:bg-stone-700">Abort</button>
          <button onClick={() => run("continue", () => api.opContinue(wt))} disabled={!!busy || d.operation.conflicted.length > 0} className="h-7 rounded-md bg-teal-700 px-3 font-medium text-white disabled:opacity-50">{busy === "continue" ? "Continuing…" : d.operation.conflicted.length > 0 ? `Continue (${d.operation.conflicted.length} unresolved)` : "Continue"}</button>
        </div>
      )}
      {(error || notice) && (
        <div className={`px-4 py-2 text-body ${error ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200" : "bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200"}`}>
          <span className="selectable">{error ? errorParts(error).message : notice}</span>
          <button onClick={() => { setError(null); setNotice(null); }} className="ml-3 underline">dismiss</button>
        </div>
      )}

      <div ref={split.box} className="flex min-h-0 min-w-0 grow">
        <aside style={{ width: split.size }} className="flex shrink-0 flex-col bg-white dark:bg-stone-800">
          <div tabIndex={0} onKeyDown={onListKey} className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto p-2 focus:outline-none">
            {d.operation && (
              <>
                <div className="px-2 pb-1 pt-1 text-label font-semibold tracking-wider text-stone-500">CONFLICTED · {d.operation.conflicted.length}</div>
                {d.operation.conflicted.map((p) => {
                  const n = d.operation!.counts[p] ?? 0;
                  return (
                    <div key={`c-${p}`} data-selected={sel?.path === p} onClick={() => setSel({ path: p, staged: false, untracked: false })} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${sel?.path === p ? "bg-amber-100 dark:bg-amber-900/40" : "bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-900/40"}`}>
                      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-700" /><span className="min-w-0 grow truncate font-mono text-body" title={p}>{p}</span>
                      {n > 0 && <span className="shrink-0 whitespace-nowrap text-label text-amber-800 dark:text-amber-300" title={`${n} ${n === 1 ? "conflict" : "conflicts"} left`}>{n}</span>}
                    </div>
                  );
                })}
                {d.operation.conflicted.length === 0 && <span className="px-2 text-body text-stone-500">None left.</span>}
                {d.operation.resolved_by_you.length > 0 && (
                  <>
                    <div className="px-2 pb-1 pt-3 text-label font-semibold tracking-wider text-stone-500">RESOLVED BY YOU · {d.operation.resolved_by_you.length}</div>
                    {d.operation.resolved_by_you.map((p) => (
                      <div key={`r-${p}`} data-selected={sel?.path === p} onClick={() => setSel({ path: p, staged: false, untracked: false })} className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${sel?.path === p ? "bg-teal-100 dark:bg-teal-900/40" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
                        <span className="w-2 shrink-0 font-semibold text-teal-700">✓</span><span className="min-w-0 grow truncate font-mono text-body" title={p}>{p}</span>
                        <button onClick={(e) => { e.stopPropagation(); run("reset", () => api.conflictReset(wt, p)); }} className="invisible shrink-0 text-label text-teal-700 hover:underline group-hover:visible" title="Back to conflicted">Undo</button>
                      </div>
                    ))}
                  </>
                )}
                {auto.length > 0 && (
                  <>
                    <button onClick={() => setShowAuto(!showAuto)} aria-expanded={showAuto} className="flex items-center gap-1 px-2 pb-1 pt-3 text-left text-label font-semibold tracking-wider text-stone-500 hover:text-stone-700 dark:hover:text-stone-300">
                      <span className="w-2.5">{showAuto ? "▾" : "▸"}</span>{auto.length} MERGED AUTOMATICALLY
                    </button>
                    {showAuto && auto.map((p) => (
                      <div key={`a-${p}`} data-selected={sel?.path === p} onClick={() => setSel({ path: p, staged: true, untracked: false })} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${sel?.path === p ? "bg-teal-100 dark:bg-teal-900/40" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
                        <span className="min-w-0 grow truncate font-mono text-body text-stone-600 dark:text-stone-300" title={p}>{p}</span>
                      </div>
                    ))}
                  </>
                )}
                <div className="my-2 border-t border-stone-200 dark:border-stone-700" />
              </>
            )}
            {/* During a merge only show other changes if there are any. */}
            {(!op || unstaged.length > 0) && <>
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <span className="text-label font-semibold tracking-wider text-stone-500">UNSTAGED · {unstaged.length}</span>
              {/* Stage all would mark conflicted files resolved, markers and all. */}
              {!op && <button onClick={() => run("stage", () => api.stageAll(wt))} disabled={unstaged.length === 0 || !!busy} className={small}>Stage all</button>}
            </div>
            {unstaged.map((f) => fileRow(f, false))}
            {unstaged.length === 0 && <span className="px-2 text-body text-stone-500">Nothing unstaged.</span>}

                        </>}
{!op && <div className="flex items-center justify-between px-2 pb-1 pt-4">
              <span className="text-label font-semibold tracking-wider text-stone-500">STAGED · {staged.length}</span>
              <button onClick={() => run("stage", () => api.unstageAll(wt))} disabled={staged.length === 0 || !!busy} className={small}>Unstage all</button>
            </div>}
            {staged.map((f) => fileRow(f, true))}
            {!op && staged.length === 0 && <span className="px-2 text-body text-stone-500">Nothing staged.</span>}

            {!op && <>
            <div className="px-2 pb-1 pt-4 text-label font-semibold tracking-wider text-stone-500">
              {d.base_branch && !isMain ? `COMMITS AHEAD OF ${d.base_branch.toUpperCase()} · ${d.ahead.length}` : `RECENT COMMITS · ${d.ahead.length}`}
            </div>
            {d.ahead.slice(0, 50).map((c) => (
              <div key={c.id} className="flex gap-2 px-2 py-1 text-body">
                <span className="font-mono text-stone-500">{c.id.slice(0, 6)}</span>
                <span className="grow truncate" title={c.summary}>{c.summary}</span>
                <span className="shrink-0 text-stone-400">{ago(c.time)}</span>
              </div>
            ))}
            {d.ahead.length === 0 && <span className="px-2 text-body text-stone-500">None.</span>}
            </>}
          </div>

          {/* During a merge or rebase, Continue makes the commit. */}
          {!op && <div className="flex shrink-0 flex-col gap-2 border-t border-stone-300 bg-stone-50 p-3 dark:border-stone-700 dark:bg-stone-900/40">
            <label htmlFor="msg" className="text-label font-semibold tracking-wider text-stone-500">COMMIT MESSAGE</label>
            <input id="msg" ref={msgRef} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={amend ? "New summary for the last commit" : "Summary"} aria-label="Summary" className="h-8 w-full rounded-md border border-stone-300 bg-white px-2 text-body focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" aria-label="Description" className="w-full resize-none rounded-md border border-stone-300 bg-white p-2 text-body focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
            <div className="flex min-w-0 items-center gap-2">
              <label className="flex shrink-0 items-center gap-1.5 text-body"><input type="checkbox" checked={amend} onChange={(e) => { setAmend(e.target.checked); if (e.target.checked && !message && d.head_summary) setMessage(d.head_summary); }} /> Amend</label>
              <div className="grow" />
              {/* Inline, because the global button rule (flex-shrink: 0) beats the class. */}
              <button onClick={doCommit} disabled={!canCommit} title={d.worktree.branch ? `Commit to ${d.worktree.branch}` : undefined} style={{ flexShrink: 1 }} className="flex h-7.5 min-w-0 items-center gap-1.5 rounded-md bg-teal-700 px-3 text-body font-medium text-white hover:bg-teal-800 disabled:opacity-50">
                <span className="min-w-0 truncate">{busy === "commit" ? "Committing…" : amend ? "Amend last commit" : `Commit ${staged.length} ${staged.length === 1 ? "file" : "files"}${d.worktree.branch ? ` to ${d.worktree.branch}` : ""}`}</span>
                <span className="shrink-0 text-body opacity-70">⌘↵</span>
              </button>
            </div>
          </div>}
        </aside>

        <SplitHandle axis="x" onMouseDown={split.start} handleRef={split.handle} />
        <main className="flex min-w-0 grow flex-col bg-white dark:bg-stone-800">
          {op && sel && (op.conflicted.includes(sel.path) || op.resolved_by_you.includes(sel.path)) ? (
            <ConflictView worktree={wt} path={sel.path} op={op} onChanged={refresh} onNextFile={nextConflicted} />
          ) : (
            <DiffView diff={diff} loading={diffLoading} mode={mode} onMode={setMode} onHunk={hunk} onLines={lines} />
          )}
        </main>
      </div>
    </div>
  );
}
