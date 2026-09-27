import { useEffect, useState } from "react";
import { ago, api, type CommitDiff, type FileDiff } from "../lib/api";
import { DiffView } from "./DiffView";
import { SplitHandle, useSplit } from "../ui/Split";

export function CommitDetail({ root, id, onBack }: { root: string; id: string; onBack?: () => void }) {
  const [c, setC] = useState<CommitDiff | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [error, setError] = useState<string | null>(null);
  const split = useSplit("pando.split.commit", 300, "x", 180, 700);

  useEffect(() => {
    setC(null); setSel(null); setDiff(null);
    api.commitDiff(root, id).then((x) => { setC(x); setSel(x.files[0]?.path ?? null); }).catch((e) => setError(String(e)));
  }, [root, id]);

  useEffect(() => {
    if (!sel) { setDiff(null); return; }
    let live = true;
    setLoading(true);
    api.commitFileDiff(root, id, sel).then((d) => { if (live) setDiff(d); }).catch((e) => setError(String(e))).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [root, id, sel]);

  useEffect(() => {
    if (!onBack) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  if (error) return <div className="p-4 text-xs text-red-700">{error}</div>;
  if (!c) return <div className="p-4 text-xs text-stone-500">Loading…</div>;

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4 text-xs dark:border-stone-700 dark:bg-stone-800">
        {onBack && <button onClick={onBack} className="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">‹ Back to list</button>}
        <span className="selectable font-mono" title={c.commit.id}>{c.commit.id.slice(0, 7)}</span>
        <span className="text-stone-500">{c.commit.author} · {ago(c.commit.time)}</span>
        <span className="text-stone-500">{c.files.length} {c.files.length === 1 ? "file" : "files"}</span>
      </div>
      <div ref={split.box} className="flex min-h-0 grow">
        <aside style={{ width: split.size }} className="flex shrink-0 flex-col overflow-y-auto bg-white dark:bg-stone-800">
          <pre className="whitespace-pre-wrap border-b border-stone-200 p-3 font-sans text-[13px] dark:border-stone-700">{c.message}</pre>
          {c.files.map((f) => (
            <button key={f.path} onClick={() => setSel(f.path)} className={`flex items-center gap-2 px-3 py-1.5 text-left ${sel === f.path ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
              <span className="grow truncate font-mono text-xs" title={f.path}>{f.path}</span>
              <span className="shrink-0 font-mono text-[11px] text-teal-700">+{f.added}</span>
              <span className="shrink-0 font-mono text-[11px] text-red-700">−{f.deleted}</span>
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
