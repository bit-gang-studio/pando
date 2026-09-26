import { useCallback, useEffect, useState } from "react";
import { ago, api, type LogEntry } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { colorFor, LANE_W, layoutGraph, ROW_H, type GraphRow } from "../lib/graph";
import { useMemo } from "react";

type Props = {
  root: string;
  /// Branch to show. Empty means all branches.
  scope: string;
  dirtyWorktrees: number;
  uncommittedLabel?: string;
  uncommittedSelected?: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onUncommitted: () => void;
  /// Called with the newest commit id after each load.
  onLoaded?: (firstId: string | null) => void;
  refreshKey: number;
};

const PAGE = 200;

export function CommitLog({ root, scope, dirtyWorktrees, uncommittedLabel, uncommittedSelected, selected, onSelect, onUncommitted, onLoaded, refreshKey }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (skip: number) => {
    try {
      const l = await api.log(root, scope || null, skip, PAGE);
      setEntries((prev) => (skip === 0 ? l.entries : [...prev, ...l.entries]));
      setTruncated(l.truncated);
      setError(null);
      if (skip === 0) onLoaded?.(l.entries[0]?.id ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [root, scope, onLoaded]);

  useEffect(() => { load(0); }, [load, refreshKey]);

  const graph = useMemo(() => layoutGraph(entries), [entries]);
  const maxLanes = Math.max(1, ...graph.map((g) => g.lanes));
  const graphW = maxLanes * LANE_W + 6;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-4 py-1.5 dark:border-stone-700 dark:bg-stone-800">
        <span className="text-xs text-stone-500">{scope ? <span className="font-mono">{scope}</span> : "All branches"} · {entries.length}{truncated ? "+" : ""} commits</span>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
      <div className="min-h-0 grow overflow-auto bg-white dark:bg-stone-800">
        {dirtyWorktrees > 0 && (
          <button onClick={onUncommitted} className={`flex w-full items-center gap-3 border-b border-stone-100 px-4 py-1.5 text-left dark:border-stone-700 ${uncommittedSelected || (selected === null && uncommittedLabel) ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-stone-400" />
            <span className="font-medium">Uncommitted changes</span>
            <span className="text-xs text-stone-500">{uncommittedLabel ?? `in ${dirtyWorktrees} ${dirtyWorktrees === 1 ? "worktree" : "worktrees"}`}</span>
          </button>
        )}
        {entries.map((e, i) => (
          <div
            key={e.id}
            style={{ height: ROW_H }}
            onClick={(ev) => (wantsNewWindow(ev) ? openInNewWindow({ kind: "commit", root, id: e.id }) : onSelect(selected === e.id ? null : e.id))}
            className={`flex cursor-pointer items-center gap-3 border-b border-stone-100 pl-2 pr-4 dark:border-stone-700 ${selected === e.id ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}
          >
            <GraphCell row={graph[i]} width={graphW} head={e.is_head} />
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

function GraphCell({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  return (
    <svg width={width} height={ROW_H} className="shrink-0" aria-hidden="true">
      {row.through.map((l) => <line key={`t${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} stroke={colorFor(l)} strokeWidth={2} />)}
      {row.into.map((l) => <path key={`i${l}`} d={`M ${x(l)} 0 C ${x(l)} ${mid} ${x(row.lane)} ${mid} ${x(row.lane)} ${mid}`} fill="none" stroke={colorFor(l)} strokeWidth={2} />)}
      <line x1={x(row.lane)} y1={0} x2={x(row.lane)} y2={mid} stroke={colorFor(row.lane)} strokeWidth={2} />
      {row.down.map((d, k) => d.from === d.to
        ? <line key={`d${k}`} x1={x(d.to)} y1={mid} x2={x(d.to)} y2={ROW_H} stroke={colorFor(d.to)} strokeWidth={2} />
        : <path key={`d${k}`} d={`M ${x(d.from)} ${mid} C ${x(d.from)} ${ROW_H} ${x(d.to)} ${mid} ${x(d.to)} ${ROW_H}`} fill="none" stroke={colorFor(d.to)} strokeWidth={2} />)}
      <circle cx={x(row.lane)} cy={mid} r={head ? 5 : 4} fill={head ? "#FFFFFF" : colorFor(row.lane)} stroke={colorFor(row.lane)} strokeWidth={2} />
    </svg>
  );
}
