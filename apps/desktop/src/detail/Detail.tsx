import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ago, api, repoName, type Detail as DetailData, type FileDiff, type FileStatus, type Hunk } from "../lib/api";
import { Chip } from "../board/Chip";
import { DiffView } from "./DiffView";

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

  const refresh = useCallback(async () => {
    try {
      const next = await api.detailLoad(root, path);
      setD(next);
      setError(null);
      setSel((s) => {
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
    api.diffFile(d.workspace.path, sel.path, sel.staged, sel.untracked)
      .then((x) => { if (live) setDiff(x); })
      .catch((e) => setError(String(e)))
      .finally(() => { if (live) setDiffLoading(false); });
    return () => { live = false; };
  }, [d, sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.activeElement !== msgRef.current) onBack();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doCommit(); }
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

  const wt = d.workspace.path;
  const unstaged = d.files.filter((f) => f.unstaged || f.untracked);
  const staged = d.files.filter((f) => f.staged);
  const conflicts = d.files.filter((f) => f.conflicted).length;
  const b = d.branch;
  const isMain = d.workspace.kind === "main";
  const canCommit = (staged.length > 0 || amend) && message.trim().length > 0 && !busy;

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
      else setError(`${r.message}${r.conflicts.length ? ` Conflicts in: ${r.conflicts.join(", ")}.` : ""} Conflict resolution lands with the M3 conflicts card.`);
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
    <div className="flex min-h-0 grow flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-300 bg-white px-4 dark:border-stone-700 dark:bg-stone-800">
        <button onClick={onBack} className="text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">Workspaces</button>
        <span className="text-stone-400">/</span>
        <span className="font-mono text-xs text-stone-500">{repoName(root)}</span>
        <span className="text-stone-400">/</span>
        <span className="font-mono text-xs font-medium">{d.workspace.branch ?? "(detached)"}</span>
        {isMain && <Chip>main worktree</Chip>}
        {b && b.ahead != null && <Chip tone={(b.behind ?? 0) > 0 ? "amber" : "grey"}>↑{b.ahead} ↓{b.behind}</Chip>}
        {d.files.length > 0 ? <Chip tone="amber">{d.files.length} changed</Chip> : <Chip>clean</Chip>}
        {conflicts > 0 && <Chip tone="red">{conflicts} conflicts</Chip>}
        {d.port != null && <Chip mono>:{d.port}</Chip>}
        <div className="grow" />
        {!isMain && d.base_branch && <button onClick={syncNow} disabled={!!busy} className={btn}>{busy === "sync" ? "Syncing…" : `Sync with ${d.base_branch}`}</button>}
        <button onClick={() => api.openInEditor(wt)} className={btn}>Open in editor <span className="text-xs text-stone-400">⌘E</span></button>
        <button disabled className={btn} title="Lands with the M3 Land card">Land <span className="text-xs text-stone-400">⌘L</span></button>
      </div>

      {(error || notice) && (
        <div className={`px-4 py-2 text-xs ${error ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200" : "bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200"}`}>
          {error ?? notice}
          <button onClick={() => { setError(null); setNotice(null); }} className="ml-3 underline">dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 grow">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-800">
          <div className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto p-2">
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

        <main className="flex min-w-0 grow flex-col bg-white dark:bg-stone-800">
          <DiffView diff={diff} loading={diffLoading} mode={mode} onMode={setMode} onHunk={hunk} onOpenFile={() => sel && api.openInEditor(`${wt}/${sel.path}`)} />
          <div className="flex h-8 shrink-0 items-center gap-3 border-t border-stone-300 bg-stone-50 px-4 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900/40">
            <span>Terminal drawer (v1.1) docks here</span>
            <div className="grow" />
            <span className="font-mono text-[11px]">⌘J</span>
          </div>
        </main>

        <aside className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-stone-300 bg-stone-100 p-4 dark:border-stone-700 dark:bg-stone-900">
          <div className="flex flex-col gap-1.5 rounded-lg border border-stone-300 bg-white p-3 text-xs dark:border-stone-700 dark:bg-stone-800">
            <div className="font-semibold">Workspace</div>
            <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1">
              <span className="text-stone-500">Path</span><button onClick={() => api.openInEditor(wt)} className="truncate text-left font-mono text-[11px] text-teal-700" title={wt}>{wt}</button>
              <span className="text-stone-500">Base</span><span className="font-mono text-[11px]">{d.base_branch ?? "—"}</span>
              <span className="text-stone-500">Tracks</span><span className="font-mono text-[11px]">{b?.upstream ?? "no upstream"}</span>
              <span className="text-stone-500">Port</span><span className="font-mono text-[11px]">{d.port != null ? `PORT=${d.port}` : "—"}</span>
              <span className="text-stone-500">HEAD</span><span className="truncate font-mono text-[11px]" title={d.workspace.head ?? ""}>{d.workspace.head?.slice(0, 7) ?? "—"}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-3 text-xs dark:border-stone-700 dark:bg-stone-800">
            <div className="font-semibold">Agent</div>
            <span className="text-stone-500">Session awareness lands with the M4 launchers card.</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-3 text-xs dark:border-stone-700 dark:bg-stone-800">
            <div className="font-semibold">Overlaps</div>
            <span className="text-stone-500">Overlap detection lands with the M4 card.</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
