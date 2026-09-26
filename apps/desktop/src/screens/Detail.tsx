import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ago, api, type Detail as DetailData, type FileDiff, type FileStatus, type Hunk } from "../lib/api";
import { Chip } from "../ui/Chip";
import { DiffView } from "./DiffView";
import { ConflictView } from "./ConflictView";
import { SplitHandle, useSplit } from "../ui/Split";
import { MergeDialog } from "../dialogs/MergeDialog";

type Props = { root: string; path: string; onBack: () => void; onChanged: () => void };
type Sel = { path: string; staged: boolean; untracked: boolean } | null;

const btn = "h-8 rounded-lg border border-stone-300 bg-white px-3 text-[13px] hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600";
const small = "h-5.5 rounded border border-stone-300 bg-white px-2 text-[11px] dark:border-stone-600 dark:bg-stone-700";

export function Detail({ root, path, onBack, onChanged }: Props) {
  const [d, setD] = useState<DetailData | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const [merging, setMerging] = useState(false);
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

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.hasFocus()) refresh(); }, 4000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.activeElement !== msgRef.current) onBack();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !merging) { e.preventDefault(); doCommit(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l" && d && d.worktree.kind === "linked" && d.worktree.branch) { e.preventDefault(); setMerging(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try { await fn(); await refresh(); onChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  }

  if (!d) return <div className="flex grow items-center justify-center text-xs text-stone-500">{error ?? "Loading…"}</div>;

  const wt = d.worktree.path;
  const unstaged = d.files.filter((f) => f.unstaged || f.untracked);
  const staged = d.files.filter((f) => f.staged);
  const conflicts = d.files.filter((f) => f.conflicted).length;
  const b = d.branch;
  const isMain = d.worktree.kind === "main";
  const canCommit = (staged.length > 0 || amend) && message.trim().length > 0 && !busy && !d.operation;

  async function doCommit() {
    if (!canCommit) return;
    await run("commit", () => api.commitCreate(wt, message.trim(), amend));
    setMessage("");
    setAmend(false);
  }

  async function discard(f: FileStatus) {
    if (!(await ask(f.untracked ? `Delete untracked file ${f.path}?` : `Discard unstaged changes in ${f.path}? This cannot be undone.`, { title: "Discard changes", kind: "warning" }))) return;
    await run("discard", () => api.discardPaths(wt, f.untracked ? [] : [f.path], f.untracked ? [f.path] : []));
  }

  async function hunk(h: Hunk, reverse: boolean) {
    if (!diff) return;
    await run("hunk", () => api.applyHunk(wt, diff.path, h, reverse));
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
      <div key={`${stagedSide}-${f.path}`} onClick={() => setSel({ path: f.path, staged: stagedSide, untracked: f.untracked })} className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${active ? "bg-teal-100 dark:bg-teal-900/40" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
        <input type="checkbox" checked={stagedSide} onChange={() => run("stage", () => (stagedSide ? api.unstagePaths(wt, [f.path]) : api.stagePaths(wt, [f.path])))} onClick={(e) => e.stopPropagation()} aria-label={stagedSide ? `Unstage ${f.path}` : `Stage ${f.path}`} className="m-0" />
        <span className={`w-3 text-center font-mono text-[11px] ${f.conflicted ? "text-red-700" : "text-stone-500"}`}>{f.conflicted ? "U" : code}</span>
        <span className="grow truncate font-mono text-xs" title={f.path}>{f.path}</span>
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
        <span className="font-mono text-xs font-medium">{d.worktree.branch ?? "(detached)"}</span>
        {isMain && <Chip>main worktree</Chip>}
        {b && b.ahead != null && <Chip tone={(b.behind ?? 0) > 0 ? "amber" : "grey"}>↑{b.ahead} ↓{b.behind}</Chip>}
        {d.files.length > 0 ? <Chip tone="amber">{d.files.length} changed</Chip> : <Chip>clean</Chip>}
        {conflicts > 0 && <Chip tone="red">{conflicts} conflicts</Chip>}
        <div className="grow" />
        {!isMain && d.base_branch && !d.operation && <button onClick={syncNow} disabled={!!busy} className={btn}>{busy === "sync" ? "Syncing…" : `Sync with ${d.base_branch}`}</button>}
        {!isMain && <button onClick={() => setMerging(true)} disabled={!d.worktree.branch || !!d.operation} className="h-8 rounded-lg bg-teal-700 px-3.5 text-[13px] font-medium text-white hover:bg-teal-800 disabled:opacity-40">Merge <span className="text-xs opacity-70">⌘L</span></button>}
      </div>

      {d.operation && (
        <div className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs dark:border-amber-800 dark:bg-amber-900/30">
          <span className="h-2 w-2 rounded-full bg-amber-700" />
          <span className="font-semibold text-amber-800 dark:text-amber-200">
            {d.operation.kind === "rebase" ? `Rebase paused onto ${d.operation.head_label}` : d.operation.kind === "merge" ? `Merge paused: ${d.operation.incoming_label} into ${d.operation.head_label}` : `Cherry-pick paused: ${d.operation.incoming_label}`}
            {d.operation.total > 0 && ` · ${d.operation.applied} of ${d.operation.total} commits`}
          </span>
          <span className="text-stone-600 dark:text-stone-300">{d.operation.conflicted.length > 0 ? `${d.operation.conflicted.length} ${d.operation.conflicted.length === 1 ? "file has" : "files have"} conflicts. Resolve each, then continue.` : "All conflicts resolved."}</span>
          <div className="grow" />
          <button onClick={() => run("abort", async () => { if (await ask("Abort and put the branch back exactly as it was?", { title: "Abort", kind: "warning" })) await api.opAbort(wt); })} disabled={!!busy} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-red-700 dark:border-stone-600 dark:bg-stone-700">Abort</button>
          <button onClick={() => run("continue", () => api.opContinue(wt))} disabled={!!busy || d.operation.conflicted.length > 0} className="h-7 rounded-md bg-teal-700 px-3 font-medium text-white disabled:opacity-50">{busy === "continue" ? "Continuing…" : d.operation.conflicted.length > 0 ? `Continue (${d.operation.conflicted.length} unresolved)` : "Continue"}</button>
        </div>
      )}
      {(error || notice) && (
        <div className={`px-4 py-2 text-xs ${error ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200" : "bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200"}`}>
          {error ?? notice}
          <button onClick={() => { setError(null); setNotice(null); }} className="ml-3 underline">dismiss</button>
        </div>
      )}

      <div ref={split.box} className="flex min-h-0 min-w-0 grow">
        <aside style={{ width: split.size }} className="flex shrink-0 flex-col bg-white dark:bg-stone-800">
          <div className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto p-2">
            {d.operation && (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] font-semibold tracking-wider text-stone-500">CONFLICTED · {d.operation.conflicted.length}</div>
                {d.operation.conflicted.map((p) => (
                  <div key={`c-${p}`} onClick={() => setSel({ path: p, staged: false, untracked: false })} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${sel?.path === p ? "bg-amber-100 dark:bg-amber-900/40" : "bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-900/40"}`}>
                    <span className="h-2 w-2 rounded-full bg-amber-700" /><span className="grow truncate font-mono text-xs">{p}</span>
                  </div>
                ))}
                {d.operation.conflicted.length === 0 && <span className="px-2 text-xs text-stone-500">None left.</span>}
                <div className="px-2 pb-1 pt-3 text-[11px] font-semibold tracking-wider text-stone-500">RESOLVED · {d.operation.resolved.length}</div>
                {d.operation.resolved.map((p) => (
                  <div key={`r-${p}`} onClick={() => setSel({ path: p, staged: true, untracked: false })} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${sel?.path === p ? "bg-teal-100 dark:bg-teal-900/40" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>
                    <span className="w-2 font-semibold text-teal-700">✓</span><span className="grow truncate font-mono text-xs">{p}</span>
                    <button onClick={(e) => { e.stopPropagation(); run("reset", () => api.conflictReset(wt, p)); }} className="text-[11px] text-teal-700 hover:underline">Undo</button>
                  </div>
                ))}
                <div className="my-2 border-t border-stone-200 dark:border-stone-700" />
              </>
            )}
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <span className="text-[11px] font-semibold tracking-wider text-stone-500">UNSTAGED · {unstaged.length}</span>
              <button onClick={() => run("stage", () => api.stageAll(wt))} disabled={unstaged.length === 0 || !!busy} className={small}>Stage all</button>
            </div>
            {unstaged.map((f) => fileRow(f, false))}
            {unstaged.length === 0 && <span className="px-2 text-xs text-stone-500">Nothing unstaged.</span>}

            <div className="flex items-center justify-between px-2 pb-1 pt-4">
              <span className="text-[11px] font-semibold tracking-wider text-stone-500">STAGED · {staged.length}</span>
              <button onClick={() => run("stage", () => api.unstageAll(wt))} disabled={staged.length === 0 || !!busy} className={small}>Unstage all</button>
            </div>
            {staged.map((f) => fileRow(f, true))}
            {staged.length === 0 && <span className="px-2 text-xs text-stone-500">Nothing staged.</span>}

            <div className="px-2 pb-1 pt-4 text-[11px] font-semibold tracking-wider text-stone-500">
              {d.base_branch && !isMain ? `COMMITS AHEAD OF ${d.base_branch.toUpperCase()} · ${d.ahead.length}` : `RECENT COMMITS · ${d.ahead.length}`}
            </div>
            {d.ahead.slice(0, 50).map((c) => (
              <div key={c.id} className="flex gap-2 px-2 py-1 text-xs">
                <span className="font-mono text-stone-500">{c.id.slice(0, 6)}</span>
                <span className="grow truncate" title={c.summary}>{c.summary}</span>
                <span className="shrink-0 text-stone-400">{ago(c.time)}</span>
              </div>
            ))}
            {d.ahead.length === 0 && <span className="px-2 text-xs text-stone-500">None.</span>}
          </div>

          <div className="flex shrink-0 flex-col gap-2 border-t border-stone-300 bg-stone-50 p-3 dark:border-stone-700 dark:bg-stone-900/40">
            <label htmlFor="msg" className="text-[11px] font-semibold tracking-wider text-stone-500">COMMIT MESSAGE</label>
            <textarea id="msg" ref={msgRef} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={amend ? "New message for the last commit" : "Summary, then details"} className="w-full resize-none rounded-md border border-stone-300 bg-white p-2 text-[13px] focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={amend} onChange={(e) => { setAmend(e.target.checked); if (e.target.checked && !message && d.head_summary) setMessage(d.head_summary); }} /> Amend</label>
              <div className="grow" />
              <button onClick={doCommit} disabled={!canCommit} className="h-7.5 rounded-md bg-teal-700 px-3 text-[13px] font-medium text-white hover:bg-teal-800 disabled:opacity-50">
                {busy === "commit" ? "Committing…" : amend ? "Amend" : `Commit ${staged.length} ${staged.length === 1 ? "file" : "files"}`} <span className="text-xs opacity-70">⌘↵</span>
              </button>
            </div>
          </div>
        </aside>

        <SplitHandle axis="x" onMouseDown={split.start} handleRef={split.handle} />
        <main className="flex min-w-0 grow flex-col bg-white dark:bg-stone-800">
          {d.operation && sel && (d.operation.conflicted.includes(sel.path) || d.operation.resolved.includes(sel.path)) ? (
            <ConflictView worktree={wt} path={sel.path} op={d.operation} onChanged={refresh} />
          ) : (
            <DiffView diff={diff} loading={diffLoading} mode={mode} onMode={setMode} onHunk={hunk} />
          )}
        </main>
      </div>
    </div>
  );
}
