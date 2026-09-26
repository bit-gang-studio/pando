import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ago, api, type Branch, type CommitDiff, type History, type Stash, type Tag } from "../lib/api";

type Props = {
  root: string;
  branch: Branch | null;
  mainBranch: string | null;
  refreshKey: number;
  onChanged: () => void;
};

const link = "text-xs text-teal-700 hover:underline";

export function BranchRail({ root, branch, mainBranch, refreshKey, onChanged }: Props) {
  const [history, setHistory] = useState<History | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [diff, setDiff] = useState<CommitDiff | null>(null);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const name = branch?.name ?? null;
  const tip = branch?.tip ?? null;

  useEffect(() => {
    api.stashes(root).then(setStashes).catch(() => setStashes([]));
    api.tags(root).then(setTags).catch(() => setTags([]));
  }, [root, refreshKey]);

  useEffect(() => {
    setDiff(null);
    setSelectedCommit(null);
    if (!name) { setHistory(null); return; }
    api.history(root, name, 100).then(setHistory).catch((e) => setError(String(e)));
  }, [root, name, tip, refreshKey]);

  useEffect(() => {
    if (!selectedCommit) { setDiff(null); return; }
    api.commitDiff(root, selectedCommit).then(setDiff).catch((e) => setError(String(e)));
  }, [root, selectedCommit]);

  async function stashAction(s: Stash, kind: "apply" | "pop" | "drop") {
    const target = branch?.checked_out_in ?? root;
    try {
      if (kind === "drop") {
        if (!(await ask(`Drop stash "${s.message}"? This cannot be undone.`, { title: "Drop stash", kind: "warning" }))) return;
        await api.stashDrop(root, s.index);
      } else {
        await api.stashApply(target, s.index, kind === "pop");
      }
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  const ahead = history?.base_index ?? null;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-stone-300 bg-stone-100 p-4 dark:border-stone-700 dark:bg-stone-900">
      {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}

      {branch ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[13px] font-medium">{branch.name}</span>
          <span className="text-xs text-stone-500">
            {branch.upstream ? `tracks ${branch.upstream}` : "no upstream"}
            {ahead != null && mainBranch && branch.name !== mainBranch && ` · ${ahead} ahead of ${mainBranch}`}
          </span>
        </div>
      ) : (
        <span className="text-xs text-stone-500">Select a branch to see its history.</span>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-stone-300 bg-white p-3 dark:border-stone-700 dark:bg-stone-800">
        <div className="flex items-center justify-between">
          <span className="font-semibold">History</span>
          <span className="text-xs text-stone-500">linear · newest first</span>
        </div>
        <div className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
          {history?.commits.map((c, i) => (
            <div key={c.id} className="contents">
              {history.base_index === i && i > 0 && (
                <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-stone-500"><span className="h-px grow bg-stone-300" /><span>{history.base_branch}</span><span className="h-px grow bg-stone-300" /></div>
              )}
              <button onClick={() => setSelectedCommit(c.id)} className={`flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${selectedCommit === c.id ? "bg-teal-100 dark:bg-teal-900/40" : "hover:bg-stone-100 dark:hover:bg-stone-700"} ${history.base_index != null && i >= history.base_index ? "text-stone-500" : ""}`}>
                <span className="truncate text-xs">{c.summary}</span>
                <span className="font-mono text-[11px] text-stone-500">{c.id.slice(0, 7)} · {c.author} · {ago(c.time)}</span>
              </button>
            </div>
          ))}
          {history && history.commits.length === 0 && <span className="text-xs text-stone-500">No commits.</span>}
        </div>
        {diff && (
          <div className="flex flex-col gap-1 border-t border-stone-200 pt-2 dark:border-stone-700">
            <div className="text-xs">
              <span className="font-mono text-stone-500">{diff.commit.id.slice(0, 7)}</span> · {diff.files.length} {diff.files.length === 1 ? "file" : "files"}
              <span className="ml-2 text-teal-700">+{diff.files.reduce((n, f) => n + f.added, 0)}</span>
              <span className="ml-1 text-red-700">−{diff.files.reduce((n, f) => n + f.deleted, 0)}</span>
            </div>
            {diff.files.map((f) => <div key={f.path} className="truncate font-mono text-[11px]">{f.path}</div>)}
            <pre className="mt-1 max-h-60 overflow-auto rounded bg-stone-900 p-2 font-mono text-[11px] leading-4 text-stone-100">{diff.patch}</pre>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-stone-300 bg-white p-3 dark:border-stone-700 dark:bg-stone-800">
        <div className="flex items-center justify-between"><span className="font-semibold">Stashes</span><span className="text-xs text-stone-500">{stashes.length}</span></div>
        {stashes.length === 0 && <span className="text-xs text-stone-500">None.</span>}
        {stashes.map((s) => (
          <div key={s.index} className="flex items-center gap-2 text-xs">
            <span className="grow truncate" title={s.message}>{s.message} <span className="text-stone-500">· {ago(s.time)}</span></span>
            <button onClick={() => stashAction(s, "apply")} className={link}>Apply</button>
            <button onClick={() => stashAction(s, "pop")} className={link}>Pop</button>
            <button onClick={() => stashAction(s, "drop")} className="text-xs text-red-700 hover:underline">Drop</button>
          </div>
        ))}
        <span className="text-[11px] text-stone-500">Applies to {branch?.checked_out_in ? "the selected branch's worktree" : "the main worktree"}.</span>
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-stone-300 bg-white p-3 dark:border-stone-700 dark:bg-stone-800">
        <div className="flex items-center justify-between"><span className="font-semibold">Tags</span><span className="text-xs text-stone-500">{tags.length}</span></div>
        {tags.slice(0, 8).map((t) => (
          <div key={t.name} className="flex items-center gap-2 text-xs"><span className="grow truncate font-mono">{t.name}</span><span className="font-mono text-stone-500">{t.target.slice(0, 7)}</span></div>
        ))}
        {tags.length > 8 && <span className="text-[11px] text-stone-500">and {tags.length - 8} more</span>}
        {tags.length === 0 && <span className="text-xs text-stone-500">None.</span>}
      </div>
    </aside>
  );
}
