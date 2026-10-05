import { useEffect, useRef, useState } from "react";
import { api, type Created } from "../lib/api";
import { ErrorLine } from "../ui/State";
import { useLayer } from "../lib/keys";
import { openEditor, openTerminal, useEditors, useTerminalName } from "../lib/reveal";

type Props = {
  root: string;
  base: string | null;
  /// An existing branch to add a worktree for. Null means create a new branch.
  initialBranch: string | null;
  /// Set when adding a worktree for a remote-only branch, e.g. "origin/feat/x".
  remote?: string | null;
  onClose: () => void;
  onCreated: () => void;
};

type Mode = "new" | "existing";
const PREFIXES = ["feat/", "fix/", "chore/", "spike/"];

const THEN_TERMINAL = "pando.newBranch.openTerminal";
const THEN_EDITOR = "pando.newBranch.openEditor";

export function NewBranchDialog({ root, base: defaultBase, initialBranch, remote = null, onClose, onCreated }: Props) {
  const repo = root;
  const mode: Mode = initialBranch ? "existing" : "new";
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [base, setBase] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withWorktree, setWithWorktree] = useState(true);
  // Remembered on this machine: people who want it want it every time.
  const [thenTerminal, setThenTerminal] = useState(() => { try { return localStorage.getItem(THEN_TERMINAL) === "1"; } catch { return false; } });
  const term = useTerminalName();
  const [thenEditor, setThenEditor] = useState(() => { try { return localStorage.getItem(THEN_EDITOR) === "1"; } catch { return false; } });
  const editor = useEditors()[0] ?? null;
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Created | null>(null);
  const branchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setBase(defaultBase ?? ""); }, [defaultBase]);

  useEffect(() => {
    branchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!repo || !branch || pathEdited) return;
    let live = true;
    api.worktreePathPreview(repo, branch).then((p) => { if (live) setPath(p); });
    return () => { live = false; };
  }, [repo, branch, pathEdited]);

  const isTop = useLayer("overlay", busy ? null : onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && isTop()) submit();
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
      if (mode === "new" && !withWorktree) {
        await api.branchCreate(repo, branch.trim(), base || null);
        onCreated();
        onClose();
        return;
      }
      const r = await api.worktreeAdd(repo, {
        branch: branch.trim(),
        base: mode === "new" && base ? base : null,
        path: pathEdited && path ? path : null,
        existing_branch: mode === "existing",
      });
      setResult(r);
      if (thenTerminal) openTerminal(r.worktree.path);
      if (thenEditor && editor) openEditor(editor, r.worktree.path);
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-labelledby="nw-title" className="flex max-h-[90vh] w-[640px] flex-col overflow-hidden rounded-xl border border-stone-300 bg-white text-body shadow-xl dark:border-stone-700 dark:bg-stone-800">
        <div className="flex flex-col gap-1 border-b border-stone-300 px-5 py-4 dark:border-stone-700">
          <h2 id="nw-title" className="text-title font-semibold">{mode === "new" ? "New branch" : "Add worktree"}</h2>
          {mode === "existing" && (
            <span className="text-stone-500">
              Check out <span className="font-mono text-stone-800 dark:text-stone-200">{initialBranch}</span> in its own folder.
              {remote && <> Creates a local branch tracking <span className="font-mono">{remote}</span>.</>}
            </span>
          )}
        </div>

        <div className="flex grow flex-col gap-4 overflow-y-auto p-5">
          {mode === "new" && (
          <div className="grid grid-cols-2 gap-3">
            {mode === "new" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-body font-medium text-stone-600 dark:text-stone-300">Base</span>
                <input list="nw-bases" value={base} onChange={(e) => setBase(e.target.value)} className="h-8 rounded-md border border-stone-300 bg-white px-2 font-mono text-body dark:border-stone-600 dark:bg-stone-700" />
                <datalist id="nw-bases">
                  {defaultBase && <option value={defaultBase} />}
                </datalist>
              </label>
            ) : <div />}
          </div>
          )}

          {mode === "new" && (
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium text-stone-600 dark:text-stone-300">Branch name</span>
            {(
              <input ref={branchRef} value={branch} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) submit(); }} placeholder="feat/my-change" spellCheck={false} className="h-8 rounded-md border border-stone-300 bg-white px-2 font-mono text-body focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700" />
            )}
            {mode === "new" && (
              <div className="flex items-center gap-1.5 text-body text-stone-500">
                <span>Prefixes:</span>
                {PREFIXES.map((p) => (
                  <button key={p} type="button" onClick={() => { setBranch(p + branch.replace(/^[a-z]+\//, "")); branchRef.current?.focus(); }} className="rounded-full border border-stone-300 px-2 py-px font-mono text-label hover:bg-stone-100 dark:border-stone-600 dark:hover:bg-stone-700">{p}</button>
                ))}
              </div>
            )}
          </label>
          )}

          {mode === "new" && (
            <label className="flex items-center gap-2"><input type="checkbox" checked={withWorktree} onChange={(e) => setWithWorktree(e.target.checked)} /> Add a worktree for it</label>
          )}

          {term && (mode === "existing" || withWorktree) && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={thenTerminal} onChange={(e) => { setThenTerminal(e.target.checked); try { localStorage.setItem(THEN_TERMINAL, e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
              Open in {term} when it's ready
            </label>
          )}

          {editor && (mode === "existing" || withWorktree) && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={thenEditor} onChange={(e) => { setThenEditor(e.target.checked); try { localStorage.setItem(THEN_EDITOR, e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
              Open in {editor} when it's ready
            </label>
          )}

          {(mode === "existing" || withWorktree) && (
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium text-stone-600 dark:text-stone-300">Location</span>
            <input value={path} onChange={(e) => { setPath(e.target.value); setPathEdited(true); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) submit(); }} spellCheck={false} className="h-8 rounded-md border border-stone-300 bg-stone-50 px-2 font-mono text-body text-stone-600 dark:border-stone-600 dark:bg-stone-700 dark:text-stone-300" />
          </label>
          )}

          {error && <ErrorLine error={error} />}
        </div>

        <div className="flex items-center gap-2 border-t border-stone-300 bg-stone-50 px-5 py-3.5 dark:border-stone-700 dark:bg-stone-900/40">
          <span className="text-stone-500">{mode === "new" && !withWorktree ? "Runs git branch." : "Runs git worktree add."}</span>
          <div className="grow" />
          <button onClick={onClose} className="h-8 rounded-lg border border-stone-300 bg-white px-3 dark:border-stone-600 dark:bg-stone-700">{result ? "Close" : "Cancel"}<span className="ml-2 text-body text-stone-400">Esc</span></button>
          {!result && (
            <button onClick={submit} disabled={!canSubmit} className="h-8 rounded-lg bg-teal-700 px-3.5 font-medium text-white hover:bg-teal-800 disabled:opacity-50">
              {busy ? "Working…" : mode === "new" ? (withWorktree ? "Create branch and worktree" : "Create branch") : "Add worktree"}<span className="ml-2 text-body opacity-70">⌘↵</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
