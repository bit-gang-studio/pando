import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileContents, type FileDiff, type FileEntry, type FileStatus } from "../lib/api";
import { BlameList, History } from "./FileView";
import { DiffView } from "./DiffView";
import { highlightLines, langFor, type Tok } from "../lib/highlight";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading, Spinner } from "../ui/State";

/// Whose files: a worktree's folder as it is on disk, or a branch or commit.
/// `head` is the commit a worktree has checked out: where its files' history starts.
export type FilesTarget = { worktree: string | null; rev: string | null; label: string; head?: string | null };
type Props = { root: string; target: FilesTarget; /** Goes up when files on disk changed. */ tick: number; onOpenCommit: (id: string) => void };
type Tab = "file" | "changes" | "blame" | "history";
/// A file's uncommitted state, in a word.
const stateOf = (f: FileStatus | undefined): { word: string; cls: string } | null =>
  !f ? null
    : f.conflicted ? { word: "conflict", cls: "text-red-700 dark:text-red-400" }
    : f.untracked ? { word: "new", cls: "text-teal-700 dark:text-teal-400" }
    : { word: "edited", cls: "text-amber-700 dark:text-amber-400" };
type Kids = FileEntry[] | { error: string } | undefined;

const FIND_LIMIT = 100;
/// Past this, colouring every line costs more than it's worth.
const HIGHLIGHT_MAX = 3000;
/// Every line is this tall, so only the ones on screen need drawing.
const LINE = 20;
/// Lines drawn above and below what's on screen, so scrolling never shows a gap.
const SPARE = 60;

/// Every file as it is right now: a tree on the left, the picked file on the right.
export function FilesPage({ root, target, tick, onOpenCommit }: Props) {
  const [tab, setTab] = useState<Tab>("file");
  // Files with uncommitted changes, for a folder on disk. A commit has none.
  const [changed, setChanged] = useState<Record<string, FileStatus>>({});
  useEffect(() => {
    if (target.rev || !target.worktree) { setChanged({}); return; }
    let live = true;
    api.detail(root, target.worktree)
      .then((d) => { if (live) setChanged(Object.fromEntries(d.files.map((f) => [f.path, f]))); })
      .catch(() => { if (live) setChanged({}); });
    return () => { live = false; };
  }, [root, target.worktree, target.rev, tick]);
  const changedPaths = useMemo(() => Object.keys(changed), [changed]);
  const mark = (path: string) => { const st = stateOf(changed[path]); return st ? <span className={`ml-auto shrink-0 pl-2 font-sans text-label ${st.cls}`}>{st.word}</span> : null; };
  const split = useSplit("pando.split.files.px", 280, "x", 180, 700);
  const [kids, setKids] = useState<Record<string, Kids>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [file, setFile] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ paths: string[]; truncated: boolean } | { error: string } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback((dir: string) => {
    api.fileList(root, target.worktree, target.rev, dir)
      .then((list) => setKids((k) => ({ ...k, [dir]: list })))
      .catch((e) => setKids((k) => ({ ...k, [dir]: { error: String(e) } })));
  }, [root, target.worktree, target.rev]);

  // A different folder, branch or commit: start again from the top.
  useEffect(() => { setKids({}); setOpen(new Set()); setFile(null); setQ(""); setFound(null); load(""); }, [load]);
  // Files changed on disk: reread the folders that are open. A commit never changes.
  const seen = useRef(tick);
  useEffect(() => {
    if (tick === seen.current || target.rev) return;
    seen.current = tick;
    load("");
    for (const d of openRef.current) load(d);
  }, [tick, target.rev, load]);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.fileFind(root, target.worktree, target.rev, query, FIND_LIMIT)
        .then((f) => { if (live) setFound(f); })
        .catch((e) => { if (live) setFound({ error: String(e) }); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [q, root, target.worktree, target.rev, tick]);

  const toggle = (dir: string) => {
    const next = new Set(open);
    if (next.has(dir)) next.delete(dir);
    else { next.add(dir); if (kids[dir] === undefined) load(dir); }
    setOpen(next);
  };

  const rowCls = (on: boolean) => `flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-body ${on ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-100 dark:hover:bg-stone-700/60"}`;
  const level = (dir: string, depth: number): React.ReactNode => {
    const list = kids[dir];
    const pad = { paddingLeft: 12 + depth * 14 };
    if (list === undefined) return <div style={pad} className="flex items-center gap-1.5 py-0.5 text-label text-stone-400"><Spinner />Loading…</div>;
    if ("error" in list) return <div style={pad} className="selectable py-0.5 pr-2 text-label text-red-700 dark:text-red-400">{list.error}</div>;
    if (list.length === 0) return <div style={pad} className="py-0.5 text-label text-stone-400">{dir ? "Empty folder" : "No files here."}</div>;
    return list.map((e) => e.dir ? (
      <div key={e.path} role="group">
        <button role="treeitem" aria-expanded={open.has(e.path)} onClick={() => toggle(e.path)} style={pad} className={rowCls(false)}>
          <span className="w-2.5 shrink-0 text-label text-stone-400">{open.has(e.path) ? "▾" : "▸"}</span>
          <span className="truncate font-mono text-body">{e.name}</span>
          {changedPaths.some((p) => p.startsWith(`${e.path}/`)) && <span title="Has uncommitted changes inside" aria-label="has uncommitted changes inside" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
        </button>
        {open.has(e.path) && level(e.path, depth + 1)}
      </div>
    ) : (
      <button key={e.path} role="treeitem" aria-selected={file === e.path} onClick={() => setFile(e.path)} style={{ paddingLeft: pad.paddingLeft + 16 }} title={e.path} className={rowCls(file === e.path)}>
        <span className="truncate font-mono text-body">{e.name}</span>
        {mark(e.path)}
      </button>
    ));
  };

  return (
    <div className="flex min-h-0 min-w-0 grow flex-col bg-white dark:bg-stone-800">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stone-200 px-4 text-body dark:border-stone-700">
        <span className="font-medium">Files</span>
        <span className="min-w-0 truncate text-stone-500">{target.label}</span>
      </div>
      <div ref={split.box} className="flex min-h-0 min-w-0 grow">
        <div style={{ width: split.size }} className="flex shrink-0 flex-col">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file" aria-label="Find a file" className="m-2 h-7 shrink-0 rounded-md border border-stone-300 bg-white px-2 text-body outline-none focus:border-teal-600 dark:border-stone-600 dark:bg-stone-700" />
          <div role="tree" aria-label="Files" className="min-h-0 grow overflow-y-auto pb-2">
            {!q.trim() ? level("", 0)
              : found === null ? <div className="px-3 py-0.5 text-label text-stone-400">Looking…</div>
              : "error" in found ? <div className="selectable px-3 py-0.5 text-label text-red-700 dark:text-red-400">{found.error}</div>
              : found.paths.length === 0 ? <div className="px-3 py-0.5 text-label text-stone-500">No file's name matches.</div>
              : <>
                  {found.paths.map((p) => {
                    const cut = p.lastIndexOf("/");
                    return (
                      <button key={p} role="treeitem" aria-selected={file === p} onClick={() => setFile(p)} title={p} className={`${rowCls(file === p)} pl-3`}>
                        <span className="shrink-0 font-mono text-body">{p.slice(cut + 1)}</span>
                        {cut > 0 && <span className="truncate text-label text-stone-400">{p.slice(0, cut)}</span>}
                        {mark(p)}
                      </button>
                    );
                  })}
                  {found.truncated && <div className="px-3 py-1 text-label text-stone-500">Showing the first {FIND_LIMIT}. Type more to narrow it down.</div>}
                </>}
          </div>
        </div>
        <SplitHandle axis="x" onMouseDown={split.start} handleRef={split.handle} />
        <div className="flex min-h-0 min-w-0 grow flex-col">
          {file
            ? <Reader key={`${target.worktree}|${target.rev}|${file}`} root={root} target={target} path={file} tick={tick} tab={target.rev && tab === "changes" ? "file" : tab} onTab={setTab} status={changed[file]} onOpenCommit={onOpenCommit} />
            : <div className="flex grow items-center justify-center p-4 text-body text-stone-500">Pick a file to read it.</div>}
        </div>
      </div>
    </div>
  );
}

function Reader({ root, target, path, tick, tab, onTab, status, onOpenCommit }: { root: string; target: FilesTarget; path: string; tick: number; tab: Tab; onTab: (t: Tab) => void; status: FileStatus | undefined; onOpenCommit: (id: string) => void }) {
  const [got, setGot] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tokens, setTokens] = useState<Tok[][] | null>(null);

  // A commit's file never changes; a file on disk is reread when the folder changes.
  const stamp = target.rev ? 0 : tick;
  useEffect(() => {
    let live = true;
    api.fileRead(root, target.worktree, target.rev, path)
      .then((c) => { if (live) { setGot(c); setError(null); } })
      .catch((e) => { if (live) { setGot(null); setError(String(e)); } });
    return () => { live = false; };
  }, [root, target.worktree, target.rev, path, attempt, stamp]);

  const lines = useMemo(() => {
    if (!got?.text) return [];
    const l = got.text.split("\n");
    // A final newline ends the last line; it doesn't start an empty one.
    if (l.length > 1 && l[l.length - 1] === "") l.pop();
    return l.map((x) => x.replace(/\r$/, ""));
  }, [got]);
  // The plain text shows first; colour arrives a moment later.
  useEffect(() => {
    setTokens(null);
    if (lines.length === 0 || lines.length > HIGHLIGHT_MAX) return;
    let live = true;
    const t = setTimeout(() => { highlightLines(lines, langFor(path)).then((x) => { if (live) setTokens(x); }); }, 30);
    return () => { live = false; clearTimeout(t); };
  }, [lines, path]);

  // Only the lines on screen are drawn. A file with 50,000 lines costs the same as one with 50.
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const measure = useCallback(() => { const el = box.current; if (el) setView({ top: el.scrollTop, height: el.clientHeight }); }, []);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, lines]);
  // A file that just got shorter can leave the remembered scroll past its end.
  const top = Math.min(view.top, Math.max(0, lines.length * LINE - view.height));
  const from = Math.max(0, Math.floor(top / LINE) - SPARE);
  const to = Math.min(lines.length, Math.ceil((top + view.height) / LINE) + SPARE);
  const longest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines]);

  const width = String(lines.length).length;
  const tabBtn = (t: Tab, label: string) => (
    <button onClick={() => onTab(t)} aria-pressed={tab === t} className={`h-6 rounded px-2 text-label ${tab === t ? "bg-stone-200 font-medium dark:bg-stone-600" : "hover:bg-stone-100 dark:hover:bg-stone-700"}`}>{label}</button>
  );
  // Blame reads the folder on disk, or the commit. History starts from a commit: the worktree's own.
  const at = { path, rev: target.rev, worktree: target.rev ? null : target.worktree, mode: "blame" as const };
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-stone-200 px-3 text-body dark:border-stone-700">
        <span className="selectable min-w-0 truncate font-mono" title={path}>{path}</span>
        {got && tab === "file" && <span className="shrink-0 text-label text-stone-500">{got.text != null ? `${lines.length} ${lines.length === 1 ? "line" : "lines"} · ` : ""}{size(got.size)}</span>}
        <div className="grow" />
        <div role="group" aria-label="What to show for this file" className="flex shrink-0 gap-0.5 rounded-md border border-stone-300 p-0.5 dark:border-stone-600">
          {tabBtn("file", "File")}
          {!target.rev && tabBtn("changes", status ? "Changes •" : "Changes")}
          {tabBtn("blame", "Blame")}
          {tabBtn("history", "History")}
        </div>
      </div>
      {tab === "changes" ? <Changes worktree={target.worktree!} path={path} status={status} tick={tick} />
        : tab === "blame" ? <BlameList root={root} target={at} onOpenCommit={onOpenCommit} />
        : tab === "history" ? <History root={root} target={{ ...at, rev: target.rev ?? target.head ?? null, worktree: null, mode: "history" }} onOpenCommit={onOpenCommit} />
        : error ? <ErrorState title="Couldn't read this file" error={error} onRetry={() => setAttempt((a) => a + 1)} />
        : !got ? <Loading />
        : got.text == null ? <div className="flex grow items-center justify-center p-4 text-body text-stone-500">{got.why}</div>
        : lines.length === 0 ? <div className="flex grow items-center justify-center p-4 text-body text-stone-500">This file is empty.</div>
        : (
          <div ref={box} onScroll={measure} aria-label={`Contents of ${path}`} className="selectable min-h-0 grow overflow-auto font-mono text-body">
            <div style={{ height: lines.length * LINE + 8, minWidth: `${longest + width + 6}ch`, paddingTop: 4 + from * LINE }}>
              {lines.slice(from, to).map((l, k) => {
                const i = from + k;
                return (
                  <div key={i} data-line={i + 1} style={{ height: LINE, lineHeight: `${LINE}px` }} className="flex">
                    <span aria-hidden style={{ width: `${width + 2}ch` }} className="sticky left-0 shrink-0 select-none bg-white pr-2 text-right text-stone-400 dark:bg-stone-800">{i + 1}</span>
                    <span className="whitespace-pre pr-4">{tokens?.[i] ? tokens[i].map((t, j) => <span key={j} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : l}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
    </>
  );
}

/// What's edited in this file and not committed: what's staged, and what isn't.
function Changes({ worktree, path, status, tick }: { worktree: string; path: string; status: FileStatus | undefined; tick: number }) {
  const [diffs, setDiffs] = useState<{ title: string; diff: FileDiff }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const key = status ? `${status.staged}|${status.unstaged}|${status.untracked}|${status.conflicted}` : "";
  useEffect(() => {
    if (!status || status.conflicted) { setDiffs([]); return; }
    let live = true;
    const want: { title: string; staged: boolean; untracked: boolean }[] = status.untracked
      ? [{ title: "New file, not committed", staged: false, untracked: true }]
      : [...(status.unstaged ? [{ title: "Not staged", staged: false, untracked: false }] : []), ...(status.staged ? [{ title: "Staged", staged: true, untracked: false }] : [])];
    Promise.all(want.map(async (w) => ({ title: w.title, diff: await api.diffFile(worktree, path, w.staged, w.untracked) })))
      .then((d) => { if (live) { setDiffs(d); setError(null); } })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree, path, key, tick, attempt]);

  const say = (text: string) => <div className="flex grow items-center justify-center p-4 text-body text-stone-500">{text}</div>;
  if (!status) return say("No uncommitted changes in this file.");
  if (status.conflicted) return say("This file has conflicts. Open the worktree to resolve them.");
  if (error) return <ErrorState title="Couldn't load this file's changes" error={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!diffs) return <Loading />;
  return (
    <div className="flex min-h-0 grow flex-col">
      {diffs.map((d) => (
        <section key={d.title} aria-label={d.title} className="flex min-h-0 grow basis-0 flex-col border-b border-stone-200 last:border-b-0 dark:border-stone-700">
          {diffs.length > 1 && <div className="shrink-0 bg-stone-50 px-3 py-1 text-label font-semibold tracking-wide text-stone-500 dark:bg-stone-900/40">{d.title.toUpperCase()}</div>}
          <DiffView diff={d.diff} loading={false} mode={mode} onMode={setMode} onHunk={() => {}} readOnly />
        </section>
      ))}
    </div>
  );
}

function size(n: number): string {
  if (n < 1000) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
