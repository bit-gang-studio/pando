import { useCallback, useEffect, useState } from "react";
import { ago, api, type LogEntry } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { colorFor, LANE_W, layoutGraph, ROW_H, type GraphRow } from "../lib/graph";
import { useMemo } from "react";
import { MoreButton } from "../ui/MoreButton";
import { ErrorState, Loading } from "../ui/State";
import { errorParts } from "../lib/errors";
import { useArrowKeys } from "../lib/useArrowKeys";

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
  /// Branch name -> dot colour class, for branches checked out in a worktree.
  branchDots?: Record<string, string>;
  /// Commit id -> dot colour classes, for detached worktrees sitting on it.
  detachedDots?: Record<string, string[]>;
  /// Commits some worktree has checked out (drawn as a hollow dot).
  heads?: Set<string>;
  /// Right-click on a commit.
  onCommitMenu?: (e: React.MouseEvent, entry: LogEntry) => void;
  /// Called with the newest commit id after each load.
  onLoaded?: (firstId: string | null) => void;
  refreshKey: number;
};

const PAGE = 200;

export function CommitLog({ root, scope, dirtyWorktrees, uncommittedLabel, uncommittedSelected, selected, onSelect, onUncommitted, branchDots = {}, detachedDots = {}, heads, onCommitMenu, onLoaded, refreshKey }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (skip: number) => {
    try {
      const l = await api.log(root, scope || null, skip, PAGE);
      setEntries((prev) => (skip === 0 ? l.entries : [...prev, ...l.entries]));
      setTruncated(l.truncated);
      setError(null);
      setLoaded(true);
      if (skip === 0) onLoaded?.(l.entries[0]?.id ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [root, scope, onLoaded]);

  useEffect(() => { load(0); }, [load, refreshKey]);

  const graph = useMemo(() => layoutGraph(entries), [entries]);
  const onListKey = useArrowKeys(entries, entries.findIndex((e) => e.id === selected), (e) => onSelect(e.id));
  const maxLanes = Math.max(1, ...graph.map((g) => g.lanes));
  const graphW = maxLanes * LANE_W + 6;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-4 py-1.5 dark:border-stone-700 dark:bg-stone-800">
        <span className="min-w-0 truncate text-body text-stone-500">{scope ? <span className="font-mono">{scope}</span> : "All branches"} · {entries.length}{truncated ? "+" : ""} commits</span>
      </div>
      <div tabIndex={0} onKeyDown={onListKey} className="min-h-0 grow overflow-auto bg-white focus:outline-none dark:bg-stone-800">
        {dirtyWorktrees > 0 && (
          <button onClick={onUncommitted} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left ${uncommittedSelected || (selected === null && uncommittedLabel) ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-stone-400" />
            <span className="font-medium">Uncommitted changes</span>
            <span className="text-body text-stone-500">{uncommittedLabel ?? `in ${dirtyWorktrees} ${dirtyWorktrees === 1 ? "worktree" : "worktrees"}`}</span>
          </button>
        )}
        {!loaded && error && <ErrorState title="Couldn't load commits" error={error} onRetry={() => load(0)} />}
        {!loaded && !error && <Loading />}
        {loaded && error && <div className="flex items-center gap-2 px-4 py-1.5 text-body text-red-700"><span className="selectable min-w-0 grow truncate">{errorParts(error).message}</span><button onClick={() => load(0)} className="underline">Retry</button></div>}
        {loaded && entries.length === 0 && dirtyWorktrees === 0 && <div className="p-4 text-body text-stone-500">No commits yet.</div>}
        {entries.map((e, i) => (
          <div
            key={e.id}
            data-selected={selected === e.id}
            style={{ height: ROW_H }}
            onClick={(ev) => (wantsNewWindow(ev) ? openInNewWindow({ kind: "commit", root, id: e.id }) : onSelect(selected === e.id ? null : e.id))}
            onContextMenu={(ev) => { if (onCommitMenu) { ev.preventDefault(); onCommitMenu(ev, e); } }}
            className={`flex cursor-pointer items-center gap-3 pl-2 pr-4 ${selected === e.id ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}
          >
            <GraphCell row={graph[i]} width={graphW} head={heads ? heads.has(e.id) : e.is_head} />
            <span className="flex shrink-0 gap-1">
              {(detachedDots[e.id] ?? []).map((dot, k) => (
                <span key={`det-${k}`} title="A worktree has this commit checked out, with no branch" className="flex items-center gap-1 rounded bg-stone-100 px-1.5 py-px font-mono text-label text-stone-700 dark:bg-stone-700 dark:text-stone-200"><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />detached</span>
              ))}
              {e.refs.map((r) => <RefChip key={r} name={r} dot={branchDots[r]} />)}
            </span>
            <span className="min-w-0 grow truncate">{e.summary}</span>
            <span className="shrink-0 text-body text-stone-500">{e.author}</span>
            <span className="w-14 shrink-0 text-right text-body text-stone-500">{ago(e.time)}</span>
            {onCommitMenu && <MoreButton onOpen={(ev) => onCommitMenu(ev, e)} label={`Actions for ${e.id.slice(0, 7)}`} />}
          </div>
        ))}
        {truncated && (
          <button onClick={() => load(entries.length)} className="m-2 rounded-md border border-stone-300 bg-white px-3 py-1 text-body dark:border-stone-600 dark:bg-stone-700">Load {PAGE} more</button>
        )}
      </div>
    </div>
  );
}

function RefChip({ name, dot }: { name: string; dot?: string }) {
  const tag = name.startsWith("tag: ");
  const remote = !tag && name.includes("/") && /^(origin|upstream)\//.test(name);
  const label = tag ? name.slice(5) : name;
  const cls = tag
    ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200"
    : remote
      ? "bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200"
      : "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";
  return (
    <span className={`flex items-center gap-1 rounded px-1.5 py-px font-mono text-label ${cls}`} title={dot ? `${name} · checked out in a worktree` : name}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
      {label}
    </span>
  );
}

function GraphCell({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  // Lines overrun the row by a pixel each way so rows never show a seam when zoomed.
  const T = -1;
  const B = ROW_H + 1;
  return (
    <svg width={width} height={ROW_H} className="shrink-0" style={{ overflow: "visible" }} aria-hidden="true">
      {row.through.map((l) => <line key={`t${l}`} x1={x(l)} y1={T} x2={x(l)} y2={B} style={{ stroke: colorFor(l) }} strokeWidth={2} />)}
      {row.into.map((l) => <path key={`i${l}`} d={`M ${x(l)} ${T} C ${x(l)} ${mid} ${x(row.lane)} ${mid} ${x(row.lane)} ${mid}`} fill="none" style={{ stroke: colorFor(l) }} strokeWidth={2} />)}
      {row.top && <line x1={x(row.lane)} y1={T} x2={x(row.lane)} y2={mid} style={{ stroke: colorFor(row.lane) }} strokeWidth={2} />}
      {row.down.map((d, k) => d.from === d.to
        ? <line key={`d${k}`} x1={x(d.to)} y1={mid} x2={x(d.to)} y2={B} style={{ stroke: colorFor(d.to) }} strokeWidth={2} />
        : <path key={`d${k}`} d={`M ${x(d.from)} ${mid} C ${x(d.from)} ${ROW_H} ${x(d.to)} ${mid} ${x(d.to)} ${B}`} fill="none" style={{ stroke: colorFor(d.to) }} strokeWidth={2} />)}
      <circle cx={x(row.lane)} cy={mid} r={head ? 5 : 4} style={{ fill: head ? "var(--graph-bg)" : colorFor(row.lane), stroke: colorFor(row.lane) }} strokeWidth={2} />
    </svg>
  );
}
