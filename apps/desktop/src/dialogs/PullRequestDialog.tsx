import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useLayer } from "../lib/keys";
import { ErrorLine } from "../ui/State";

type Props = {
  root: string;
  branch: string;
  /// The base to start with, and the others to offer.
  base: string;
  bases: string[];
  onClose: () => void;
  onCreated: (url: string) => void;
};

/// Open a pull request on GitHub for a branch. The form starts from its commits.
export function PullRequestDialog({ root, branch, base: firstBase, bases, onClose, onCreated }: Props) {
  const [base, setBase] = useState(firstBase);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [commits, setCommits] = useState<number | null>(null);
  // Once you've typed, changing the base no longer replaces your text.
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setCommits(null);
    api.prDraft(root, branch, base).then((d) => {
      if (!live) return;
      setCommits(d.commits);
      setError(null);
      if (!typed) { setTitle(d.title); setBody(d.body); requestAnimationFrame(() => ref.current?.select()); }
    }).catch((e) => { if (live) { setError(String(e)); setCommits(0); } });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, branch, base]);

  const can = !busy && commits !== null && commits > 0 && title.trim().length > 0;
  async function submit() {
    if (!can) return;
    setBusy(true);
    setError(null);
    try { onCreated(await api.prCreate(root, { branch, base, title: title.trim(), body: body.trim(), draft })); onClose(); }
    catch (e) { setError(String(e)); setBusy(false); }
  }

  const isTop = useLayer("overlay", busy ? null : onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && isTop()) { e.preventDefault(); submit(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const field = "rounded-md border border-stone-300 bg-white px-2 text-body focus:border-teal-700 focus:outline-none disabled:opacity-50 dark:border-stone-600 dark:bg-stone-700";
  const edit = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setTyped(true); set(e.target.value); };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-labelledby="pr-title" className="flex max-h-[90vh] w-[600px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-body shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex flex-col gap-1 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 id="pr-title" className="text-title font-semibold">Create pull request</h2>
          <span className="flex flex-wrap items-center gap-1.5 text-stone-500">
            <span className="font-mono text-stone-800 dark:text-stone-200">{branch}</span> into
            <select aria-label="Base" value={base} onChange={(e) => setBase(e.target.value)} disabled={busy} className={`h-7 font-mono ${field}`}>
              {bases.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            {commits !== null && <span className="whitespace-nowrap">· {commits} {commits === 1 ? "commit" : "commits"}</span>}
          </span>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto p-5">
          {error && <ErrorLine error={error} />}
          {commits === 0 && !error && <div className="rounded-md bg-amber-50 px-3 py-2 dark:bg-amber-900/30"><span className="font-mono">{base}</span> already has everything on <span className="font-mono">{branch}</span>. There's nothing to open a pull request for.</div>}
          <input ref={ref} value={title} onChange={edit(setTitle)} onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) submit(); }} placeholder="Title" aria-label="Title" className={`h-8 ${field}`} />
          <textarea rows={9} value={body} onChange={edit(setBody)} placeholder="Description (optional)" aria-label="Description" className={`resize-none py-2 ${field}`} />
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft: not ready for review yet</label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-300 px-5 py-3 dark:border-stone-700">
          <span className="grow text-label text-stone-500">Commits that aren't pushed yet are pushed first.</span>
          <button onClick={onClose} disabled={busy} className="h-8 rounded-lg border border-stone-300 bg-white px-3 hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600">Cancel</button>
          <button onClick={submit} disabled={!can} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-40">{busy ? "Creating…" : draft ? "Create draft" : "Create pull request"}<span className="ml-2 opacity-70">⌘↵</span></button>
        </div>
      </div>
    </div>
  );
}
