import { useEffect, useRef, useState } from "react";
import { api, type BranchDefaults, type Created } from "../lib/api";

type Props = {
  root: string;
  base: string | null;
  /// An existing branch to add a worktree for. Null means create a new branch.
  initialBranch: string | null;
  onClose: () => void;
  onCreated: () => void;
};

type Mode = "new" | "existing";
const PREFIXES = ["feat/", "fix/", "chore/", "spike/"];

export function NewBranchDialog({ root, base: defaultBase, initialBranch, onClose, onCreated }: Props) {
  const repo = root;
  const mode: Mode = initialBranch ? "existing" : "new";
  const [defaults, setDefaults] = useState<BranchDefaults | null>(null);
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [base, setBase] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [runHooks, setRunHooks] = useState(true);
  const [openAfter, setOpenAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Created | null>(null);
  const branchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!repo) return;
    setDefaults(null);
    api.branchDefaults(repo).then((d) => {
      setDefaults(d);
      setBase(d.base ?? defaultBase ?? "");
    }).catch((e) => setError(String(e)));
  }, [repo]);

  useEffect(() => {
    branchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!repo || !branch || pathEdited) return;
    let live = true;
    api.worktreePathPreview(repo, branch).then((p) => { if (live) setPath(p); });
    return () => { live = false; };
  }, [repo, branch, pathEdited]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

    const canSubmit = !!repo && !!branch.trim() && !busy && !result;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.worktreeAdd(repo, {
        branch: branch.trim(),
        base: mode === "new" && base ? base : null,
        path: pathEdited && path ? path : null,
        existing_branch: mode === "existing",
        run_hooks: runHooks,
      });
      setResult(r);
      onCreated();
      const failed = r.hooks.some((h) => h.exit_code !== 0);
      if (!failed) {
        if (openAfter) api.openInEditor(r.worktree.path).catch(() => {});
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const hooks = defaults?.hooks ?? [];
  const port = defaults?.next_port ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-labelledby="nw-title" className="flex max-h-[90vh] w-[720px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-[13px] shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex items-center gap-3 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 id="nw-title" className="text-base font-semibold">{mode === "new" ? "New branch" : `Add worktree for ${initialBranch}`}</h2>
        </div>

        <div className="flex grow flex-col gap-4 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3">
            {mode === "new" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Base</span>
                <input list="nw-bases" value={base} onChange={(e) => setBase(e.target.value)} className="h-8 rounded-md border border-stone-300 bg-white px-2 font-mono text-xs dark:border-stone-600 dark:bg-stone-700" />
                <datalist id="nw-bases">
                  {defaults?.base && <option value={defaults.base} />}
                </datalist>
              </label>
            ) : <div />}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Branch name</span>
            {mode === "new" ? (
              <input ref={branchRef} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/my-change" spellCheck={false} className="h-8 rounded-md border border-stone-300 bg-white px-2 font-mono text-xs focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
            ) : (
              <div className="flex h-8 items-center rounded-md border border-stone-300 bg-stone-50 px-2 font-mono text-xs dark:border-stone-600 dark:bg-stone-700">{initialBranch}</div>
            )}
            {mode === "new" && (
              <div className="flex items-center gap-1.5 text-xs text-stone-500">
                <span>Prefixes:</span>
                {PREFIXES.map((p) => (
                  <button key={p} type="button" onClick={() => { setBranch(p + branch.replace(/^[a-z]+\//, "")); branchRef.current?.focus(); }} className="rounded-full border border-stone-300 px-2 py-px font-mono text-[11px] hover:bg-stone-100 dark:border-stone-600 dark:hover:bg-stone-700">{p}</button>
                ))}
              </div>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-stone-600 dark:text-stone-300">Location</span>
            <input value={path} onChange={(e) => { setPath(e.target.value); setPathEdited(true); }} spellCheck={false} className="h-8 rounded-md border border-stone-300 bg-stone-50 px-2 font-mono text-xs text-stone-600 dark:border-stone-600 dark:bg-stone-700 dark:text-stone-300" />
          </label>

          <div className="flex flex-col gap-2 rounded-lg border border-stone-300 bg-stone-50 p-3 dark:border-stone-600 dark:bg-stone-900/40">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wider text-stone-500">SETUP</span>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={runHooks} onChange={(e) => setRunHooks(e.target.checked)} /> Run hooks</label>
            </div>
            {hooks.length === 0 && port == null && <div className="text-xs text-stone-500">No setup commands or port configured. Set them in this repo's settings.</div>}
            {hooks.map((h, i) => <div key={i} className={`font-mono text-xs ${runHooks ? "" : "line-through opacity-50"}`}>{h}</div>)}
            {port != null && <div className="font-mono text-xs">PORT={port}</div>}
          </div>

          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} /> Open in editor after create</label>

          {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}
          {result && result.hooks.some((h) => h.exit_code !== 0) && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-900/30">
              <div className="font-medium">Worktree created, but a setup hook failed. Fix it and run the rest by hand.</div>
              {result.hooks.map((h, i) => (
                <div key={i}>
                  <div className="font-mono">{h.exit_code === 0 ? "ok  " : "FAIL"} {h.command}</div>
                  {h.exit_code !== 0 && <pre className="mt-1 max-h-40 overflow-auto rounded bg-stone-900 p-2 font-mono text-[11px] text-stone-100">{h.stdout}{h.stderr}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-50 px-5 py-3.5 dark:border-stone-700 dark:bg-stone-900/40">
          <span className="text-xs text-stone-500">Runs git worktree add. Nothing is pushed.</span>
          <div className="grow" />
          <button onClick={onClose} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">{result ? "Close" : "Cancel"}<span className="ml-2 text-xs text-stone-400">Esc</span></button>
          {!result && (
            <button onClick={submit} disabled={!canSubmit} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">
              {busy ? "Adding…" : mode === "new" ? "Create branch and worktree" : "Add worktree"}<span className="ml-2 text-xs opacity-70">⌘↵</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
