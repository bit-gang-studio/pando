import { useCallback, useEffect, useState } from "react";
import { ago, api, type LogEntry } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";

type Props = {
  root: string;
  branches: string[];
  dirtyWorktrees: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onUncommitted: () => void;
  refreshKey: number;
};

const PAGE = 200;

export function CommitLog({ root, branches, dirtyWorktrees, selected, onSelect, onUncommitted, refreshKey }: Props) {
  const [scope, setScope] = useState<string>("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (skip: number) => {
    try {
      const l = await api.log(root, scope || null, skip, PAGE);
      setEntries((prev) => (skip === 0 ? l.entries : [...prev, ...l.entries]));
      setTruncated(l.truncated);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [root, scope]);

  useEffect(() => { load(0); }, [load, refreshKey]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-4 py-1.5 dark:border-stone-700 dark:bg-stone-800">
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="h-7 rounded-md border border-stone-300 bg-white px-2 text-xs dark:border-stone-600 dark:bg-stone-700">
          <option value="">All branches</option>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <span className="text-xs text-stone-500">{entries.length}{truncated ? "+" : ""} commits</span>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
      <div className="min-h-0 grow overflow-auto bg-white dark:bg-stone-800">
        {dirtyWorktrees > 0 && (
          <button onClick={onUncommitted} className="flex w-full items-center gap-3 border-b border-stone-100 px-4 py-1.5 text-left hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-700/50">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-stone-400" />
            <span className="font-medium">Uncommitted changes</span>
            <span className="text-xs text-stone-500">in {dirtyWorktrees} {dirtyWorktrees === 1 ? "worktree" : "worktrees"}</span>
          </button>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            onClick={(ev) => (wantsNewWindow(ev) ? openInNewWindow({ kind: "commit", root, id: e.id }) : onSelect(selected === e.id ? null : e.id))}
            className={`flex cursor-pointer items-center gap-3 border-b border-stone-100 px-4 py-1.5 dark:border-stone-700 ${selected === e.id ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}
          >
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${e.is_head ? "bg-teal-700" : e.parents.length > 1 ? "bg-stone-300 dark:bg-stone-600" : "bg-stone-400"}`} />
            <span className="flex shrink-0 gap-1">
              {e.refs.map((r) => <RefChip key={r} name={r} />)}
            </span>
            <span className="min-w-0 grow truncate">{e.summary}</span>
            <span className="shrink-0 text-xs text-stone-500">{e.author}</span>
            <span className="w-14 shrink-0 text-right text-xs text-stone-500">{ago(e.time)}</span>
          </div>
        ))}
        {truncated && (
          <button onClick={() => load(entries.length)} className="m-2 rounded-md border border-stone-300 bg-white px-3 py-1 text-xs dark:border-stone-600 dark:bg-stone-700">Load {PAGE} more</button>
        )}
      </div>
    </div>
  );
}

function RefChip({ name }: { name: string }) {
  const tag = name.startsWith("tag: ");
  const remote = !tag && name.includes("/") && /^(origin|upstream)\//.test(name);
  const label = tag ? name.slice(5) : name;
  const cls = tag
    ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200"
    : remote
      ? "bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200"
      : "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";
  return <span className={`rounded px-1.5 py-px font-mono text-[11px] ${cls}`} title={name}>{label}</span>;
}
