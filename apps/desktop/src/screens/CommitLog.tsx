import { useCallback, useEffect, useState } from "react";
import { ago, api, type LogEntry, type PullRequest } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { colorFor, LANE_W, layoutGraph, ROW_H, type GraphRow } from "../lib/graph";
import { useMemo } from "react";
import { MoreButton } from "../ui/MoreButton";
import { ErrorState, Loading } from "../ui/State";
import { errorParts } from "../lib/errors";
import { useArrowKeys } from "../lib/useArrowKeys";
import { PrBadge } from "../ui/PrBadge";
import { Fragment } from "react";

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
  /// Branch name -> its open pull request.
  prByBranch?: Record<string, PullRequest>;
  /// Commit id -> dot colour classes, for detached worktrees sitting on it.
  detachedDots?: Record<string, string[]>;
  /// Commits some worktree has checked out (drawn as a hollow dot).
  heads?: Set<string>;
  /// A top row with everything the branch changes vs its base.
  compare?: { base: string; ahead: number | null };
  /// List the branch's own commits (`own`, e.g. "origin/main..feat/x") first,
  /// then the shared history from `rest` (where it left the base), dimmed.
  range?: { own: string; rest: string | null; restLabel: string };
  compareSelected?: boolean;
  onCompare?: () => void;
  /// Commits picked together with shift-click, highlighted with `selected`.
  picked?: Set<string>;
  /// The far end of that pick (the near end is `selected`).
  spanEnd?: string | null;
  /// Shift-click or Shift+Up/Down: pick from `selected` to another commit.
  onSpan?: (span: Span) => void;
  /// Right-click on a commit.
  onCommitMenu?: (e: React.MouseEvent, entry: LogEntry) => void;
  /// Called with the newest commit id after each load.
  onLoaded?: (firstId: string | null) => void;
  refreshKey: number;
};

/// `anchor` is where the pick started, `other` where it ends now. `older` and
/// `newer` are the same two, by their place in the list.
export type Span = { anchor: string; other: string; older: string; newer: string };

const PAGE = 200;

export function CommitLog({ root, scope, dirtyWorktrees, uncommittedLabel, uncommittedSelected, selected, onSelect, onUncommitted, branchDots = {}, prByBranch = {}, detachedDots = {}, heads, compare, compareSelected, onCompare, range, picked, spanEnd, onSpan, onCommitMenu, onLoaded, refreshKey }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ownCount, setOwnCount] = useState<number | null>(null);
  const own = range?.own ?? null, rest = range?.rest ?? null;

  const load = useCallback(async (skip: number) => {
    try {
      let l;
      if (own) {
        // The branch's own commits (all of them), then shared history, paged.
        if (skip === 0) {
          const mine = await api.log(root, own, 0, 2000);
          const earlier = rest ? await api.log(root, rest, 0, PAGE) : { entries: [], truncated: false };
          setOwnCount(mine.entries.length);
          l = { entries: [...mine.entries, ...earlier.entries], truncated: earlier.truncated };
        } else {
          l = rest ? await api.log(root, rest, skip - (ownCount ?? 0), PAGE) : { entries: [], truncated: false };
        }
      } else {
        setOwnCount(null);
        l = await api.log(root, scope || null, skip, PAGE);
      }
      setEntries((prev) => (skip === 0 ? l.entries : [...prev, ...l.entries]));
      setTruncated(l.truncated);
      setError(null);
      setLoaded(true);
      if (skip === 0) onLoaded?.(l.entries[0]?.id ?? null);
    } catch (e) {
      setError(String(e));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, scope, own, rest, onLoaded]);

  useEffect(() => { load(0); }, [load, refreshKey]);

  const graph = useMemo(() => layoutGraph(entries), [entries]);
  const moveKey = useArrowKeys(entries, entries.findIndex((e) => e.id === selected), (e) => onSelect(e.id));
  const at = (id: string | null | undefined) => entries.findIndex((e) => e.id === id);
  /// Pick everything from the selected commit to row `to`.
  function spanTo(to: number) {
    const from = at(selected);
    if (!onSpan || from < 0 || to < 0) return false;
    if (to === from) { onSelect(entries[from].id); return true; }
    const [hi, lo] = to < from ? [to, from] : [from, to];
    onSpan({ anchor: entries[from].id, other: entries[to].id, newer: entries[hi].id, older: entries[lo].id });
    return true;
  }
  const onListKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!e.shiftKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return moveKey(e);
    const end = at(spanEnd) >= 0 ? at(spanEnd) : at(selected);
    if (end < 0) return moveKey(e);
    e.preventDefault();
    const to = Math.max(0, Math.min(entries.length - 1, end + (e.key === "ArrowDown" ? 1 : -1)));
    spanTo(to);
    const list = e.currentTarget;
    requestAnimationFrame(() => list.querySelector(`[data-row="${to}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const maxLanes = Math.max(1, ...graph.map((g) => g.lanes));
  const graphW = maxLanes * LANE_W + 6;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-4 py-1.5 dark:border-stone-700 dark:bg-stone-800">
        <span className="min-w-0 truncate text-body text-stone-500">{scope ? <span className="font-mono">{scope}</span> : "All branches"} · {ownCount != null ? `${ownCount} ${ownCount === 1 ? "commit" : "commits"} on this branch` : `${entries.length}${truncated ? "+" : ""} commits`}</span>
      </div>
      <div tabIndex={0} onKeyDown={onListKey} className="min-h-0 grow overflow-auto bg-white focus:outline-none dark:bg-stone-800">
        {dirtyWorktrees > 0 && (
          <button onClick={onUncommitted} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left ${uncommittedSelected || (selected === null && uncommittedLabel && !compareSelected) ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-stone-400" />
            <span className="font-medium">Uncommitted changes</span>
            <span className="text-body text-stone-500">{uncommittedLabel ?? `in ${dirtyWorktrees} ${dirtyWorktrees === 1 ? "worktree" : "worktrees"}`}</span>
          </button>
        )}
        {compare && (
          <button onClick={onCompare} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left ${compareSelected ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm border-2 border-stone-400" />
            <span className="font-medium">All changes</span>
            <span className="text-body text-stone-500">since <span className="font-mono">{compare.base}</span>{compare.ahead != null ? ` · ${compare.ahead} ${compare.ahead === 1 ? "commit" : "commits"}` : ""}</span>
          </button>
        )}
        {!loaded && error && <ErrorState title="Couldn't load commits" error={error} onRetry={() => load(0)} />}
        {!loaded && !error && <Loading />}
        {loaded && error && <div className="flex items-center gap-2 px-4 py-1.5 text-body text-red-700"><span className="selectable min-w-0 grow truncate">{errorParts(error).message}</span><button onClick={() => load(0)} className="underline">Retry</button></div>}
        {loaded && entries.length === 0 && dirtyWorktrees === 0 && <div className="p-4 text-body text-stone-500">No commits yet.</div>}
        {entries.map((e, i) => (
          <Fragment key={e.id}>
          {ownCount != null && i === ownCount && (
            <div className="flex items-center gap-2 border-y border-stone-200 bg-stone-50 px-4 py-1 text-label text-stone-500 dark:border-stone-700 dark:bg-stone-900/40">{range?.restLabel}</div>
          )}
          <div
            data-selected={selected === e.id}
            data-picked={!!picked?.has(e.id)}
            data-row={i}
            style={{ height: ROW_H }}
            onMouseDown={(ev) => { if (ev.shiftKey) ev.preventDefault(); }}
            onClick={(ev) => {
              if (wantsNewWindow(ev)) openInNewWindow({ kind: "commit", root, id: e.id });
              else if (ev.shiftKey && spanTo(i)) return;
              else onSelect(selected === e.id && !picked?.size ? null : e.id);
            }}
            onContextMenu={(ev) => { if (onCommitMenu) { ev.preventDefault(); onCommitMenu(ev, e); } }}
            className={`flex cursor-pointer items-center gap-3 pl-2 pr-4 ${(picked?.size ? picked.has(e.id) : selected === e.id) ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}
          >
            <GraphCell row={graph[i]} width={graphW} head={heads ? heads.has(e.id) : e.is_head} />
            {/* Earlier history is dimmed, but not the graph: see-through lane lines that
                overlap row to row would draw as dots at every row boundary. */}
            <div data-dim={ownCount != null && i >= ownCount && selected !== e.id && !picked?.has(e.id)} className={`flex min-w-0 grow items-center gap-3 ${ownCount != null && i >= ownCount && selected !== e.id && !picked?.has(e.id) ? "opacity-60" : ""}`}>
            <span className="flex shrink-0 gap-1">
              {(detachedDots[e.id] ?? []).map((dot, k) => (
                <span key={`det-${k}`} title="A worktree has this commit checked out, with no branch" className="flex items-center gap-1 rounded bg-stone-100 px-1.5 py-px font-mono text-label text-stone-700 dark:bg-stone-700 dark:text-stone-200"><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />detached</span>
              ))}
              {e.refs.map((r) => <RefChip key={r} name={r} dot={branchDots[r]} />)}
              {[...new Set(e.refs.map((r) => prByBranch[r]).filter(Boolean))].map((pr) => <PrBadge key={pr.number} pr={pr} />)}
            </span>
            <span className="min-w-0 grow truncate">{e.summary}</span>
            <span className="selectable shrink-0 font-mono text-label text-stone-400" title={e.id}>{e.id.slice(0, 7)}</span>
            <span className="shrink-0 text-body text-stone-500">{e.author}</span>
            <span className="w-14 shrink-0 text-right text-body text-stone-500">{ago(e.time)}</span>
            {onCommitMenu && <MoreButton onOpen={(ev) => onCommitMenu(ev, e)} label={`Actions for ${e.id.slice(0, 7)}`} />}
            </div>
          </div>
          </Fragment>
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
