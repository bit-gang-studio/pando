import { useCallback, useEffect, useRef, useState } from "react";
import { ago, api, type LogEntry, type PullRequest } from "../lib/api";
import { openInNewWindow, wantsNewWindow } from "../lib/windows";
import { colorFor, LANE_W, layoutGraph, ROW_H, type GraphRow } from "../lib/graph";
import { useMemo } from "react";
import { MoreButton } from "../ui/MoreButton";
import { ErrorState, Loading } from "../ui/State";
import { errorParts } from "../lib/errors";
import { useArrowKeys } from "../lib/useArrowKeys";
import { PrBadge } from "../ui/PrBadge";
import { overlayOpen } from "../lib/keys";
import { Fragment } from "react";

type Props = {
  root: string;
  /// Branch to show. Empty means all branches.
  scope: string;
  /// What the list is, when it isn't simply `scope`'s commits.
  title?: React.ReactNode;
  /// Rows above the commits that stand for many at once ("everything this side
  /// changed"). Drawn with a dashed outline: a sum, not a commit.
  /// `tip`: the branch it sums up. Its dot sits above that branch's line in the
  /// graph, joined to it by a dashed line. `empty`: nothing to sum; it has no line.
  totals?: { key: string; label: React.ReactNode; detail: string; selected: boolean; onClick: () => void; tip?: string; empty?: boolean }[];
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
  /// With `revs`, "own" is every commit any of those branches has that `rest`
  /// doesn't (several branches since they split); `own` then only names it.
  range?: { own: string; rest: string | null; restLabel: string; revs?: string[] };
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
const MAX_LANES = 12;

export function CommitLog({ root, scope, title, totals, dirtyWorktrees, uncommittedLabel, uncommittedSelected, selected, onSelect, onUncommitted, branchDots = {}, prByBranch = {}, detachedDots = {}, heads, compare, compareSelected, onCompare, range, picked, spanEnd, onSpan, onCommitMenu, onLoaded, refreshKey }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ownCount, setOwnCount] = useState<number | null>(null);
  const own = range?.own ?? null, rest = range?.rest ?? null;

  // Only the newest request may change the list: a slow answer to an older
  // one (a second click, a refresh landing mid-load) would add rows twice.
  const request = useRef(0);
  const loadedCount = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async (skip: number, keep = false) => {
    const mine = ++request.current;
    try {
      let l;
      let ownLen: number | null = null;
      // A refresh keeps as many rows as were loaded, so "Load more" isn't undone.
      const page = keep ? Math.max(PAGE, loadedCount.current) : PAGE;
      if (own) {
        // The branch's own commits (all of them), then shared history, paged.
        if (skip === 0) {
          const ownLog = range?.revs ? await api.logAmong(root, range.revs, rest, 2000) : await api.log(root, own, 0, 2000);
          const earlier = rest ? await api.log(root, rest, 0, Math.max(PAGE, page - ownLog.entries.length)) : { entries: [], truncated: false };
          ownLen = ownLog.entries.length;
          l = { entries: [...ownLog.entries, ...earlier.entries], truncated: earlier.truncated };
        } else {
          l = rest ? await api.log(root, rest, skip - (ownCount ?? 0), PAGE) : { entries: [], truncated: false };
        }
      } else {
        l = await api.log(root, scope || null, skip, page);
      }
      if (mine !== request.current) return;
      if (!own) setOwnCount(null);
      else if (ownLen !== null) setOwnCount(ownLen);
      setEntries((prev) => {
        const seen = new Set(skip === 0 ? [] : prev.map((e) => e.id));
        const next = skip === 0 ? l.entries : [...prev, ...l.entries.filter((e) => !seen.has(e.id))];
        loadedCount.current = next.length;
        return next;
      });
      setTruncated(l.truncated);
      setError(null);
      setLoaded(true);
      if (skip === 0) onLoaded?.(l.entries[0]?.id ?? null);
    } catch (e) {
      if (mine === request.current) setError(String(e));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, scope, own, rest, onLoaded]);
  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try { await load(entries.length); } finally { setLoadingMore(false); }
  }

  // A new repo or branch starts from one page; a refresh of the same one keeps what's loaded.
  const first = useRef(true);
  useEffect(() => { first.current = true; loadedCount.current = 0; }, [load]);
  useEffect(() => { load(0, !first.current); first.current = false; }, [load, refreshKey]);

  // ---- search: message, author or commit id, in this scope -----------------------
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; entries: LogEntry[]; truncated: boolean } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const q = query.trim();
  const search = useCallback(async (text: string, skip: number) => {
    try {
      const l = await api.logSearch(root, scope || null, text, skip, PAGE);
      setFound((prev) => ({ q: text, entries: skip === 0 || prev?.q !== text ? l.entries : [...prev.entries, ...l.entries], truncated: l.truncated }));
      setSearchError(null);
    } catch (e) { setSearchError(String(e)); }
  }, [root, scope]);
  useEffect(() => {
    if (!q) { setFound(null); setSearchError(null); return; }
    // Wait for a pause in typing.
    const t = setTimeout(() => search(q, 0), 200);
    return () => clearTimeout(t);
  }, [q, search, refreshKey]);
  useEffect(() => { setQuery(""); }, [root, scope]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f" && !overlayOpen()) { e.preventDefault(); searchBox.current?.focus(); searchBox.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // While searching, the list is the results: plain rows, no graph, no picking a range.
  const searching = q !== "";
  const results = found?.q === q ? found : null;
  const graphEntries = entries;
  const rows = searching ? results?.entries ?? [] : entries;

  const graph = useMemo(() => layoutGraph(graphEntries), [graphEntries]);
  const moveKey = useArrowKeys(rows, rows.findIndex((e) => e.id === selected), (e) => onSelect(e.id));
  const at = (id: string | null | undefined) => rows.findIndex((e) => e.id === id);
  /// Pick everything from the selected commit to row `to`.
  function spanTo(to: number) {
    const from = at(selected);
    if (!onSpan || searching || from < 0 || to < 0) return false;
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
    if (searching) return moveKey(e);
    const to = Math.max(0, Math.min(entries.length - 1, end + (e.key === "ArrowDown" ? 1 : -1)));
    spanTo(to);
    const list = e.currentTarget;
    requestAnimationFrame(() => list.querySelector(`[data-row="${to}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  // A history with many branches side by side can be dozens of lanes wide.
  // Cap the graph so the commit text always stays on screen; lanes past the
  // cap are cut off, and a commit out there gets its dot at the edge.
  // Each total sits above its branch's line. One with nothing in it has no line,
  // so it takes the next free lane to the right.
  const totalAt = useMemo(() => {
    let free = Math.max(0, ...graph.map((g) => g.lanes));
    return (totals ?? []).map((t) => {
      const row = t.tip && !t.empty ? rows.findIndex((e) => e.id === t.tip || e.refs.includes(t.tip!)) : -1;
      return row >= 0 ? { lane: graph[row].lane, row } : { lane: free++, row: -1 };
    });
  }, [totals, rows, graph]);
  const maxLanes = Math.min(MAX_LANES, Math.max(1, ...graph.map((g) => g.lanes), ...(searching ? [] : totalAt.map((t) => t.lane + 1))));
  const graphW = maxLanes * LANE_W + 6;
  /// Lanes a total's dashed line runs down through at `row` (-1 - k for the k-th
  /// totals row itself), on its way to the branch's newest commit.
  const lead = (row: number) => totalAt.filter((t, k) => t.row >= 0 && (row < 0 ? k < -1 - row : t.row >= row)).map((t) => ({ lane: t.lane, ends: t.row === row }));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 bg-white px-4 py-1.5 dark:border-stone-700 dark:bg-stone-800">
        <span className="min-w-0 truncate text-body text-stone-500">{title ?? <>{scope ? <span className="font-mono">{scope}</span> : "All branches"} · {ownCount != null ? `${ownCount} ${ownCount === 1 ? "commit" : "commits"} on this branch` : `${entries.length}${truncated ? "+" : ""} commits`}</>}</span>
        <div className="grow" />
        <input
          ref={searchBox}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } else if (e.key === "Escape") e.currentTarget.blur(); }}
          placeholder="Search commits  ⌘F"
          aria-label="Search commits"
          spellCheck={false}
          className="h-6.5 w-56 shrink-0 rounded-md border border-stone-300 bg-white px-2 text-body focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700"
        />
      </div>
      <div tabIndex={0} onKeyDown={onListKey} className="min-h-0 grow overflow-auto bg-white focus:outline-none dark:bg-stone-800">
        {searching && (
          <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-1 text-label text-stone-500 dark:border-stone-700 dark:bg-stone-900/40">
            <span className="min-w-0 grow truncate">
              {searchError ? <span className="text-red-700">{errorParts(searchError).message}</span>
                : !results ? "Searching…"
                : results.entries.length === 0 ? <>No commits match “{q}”{scope ? <> on <span className="font-mono">{scope}</span></> : ""}.</>
                : <>{results.entries.length}{results.truncated ? "+" : ""} {results.entries.length === 1 && !results.truncated ? "commit matches" : "commits match"} “{q}”{scope ? <> on <span className="font-mono">{scope}</span></> : ""}</>}
            </span>
            {searchError && <button onClick={() => search(q, 0)} className="underline">Retry</button>}
            <button onClick={() => setQuery("")} className="underline">Clear</button>
          </div>
        )}
        {!searching && dirtyWorktrees > 0 && (
          <button onClick={onUncommitted} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left ${uncommittedSelected || (selected === null && uncommittedLabel && !compareSelected) ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-stone-400" />
            <span className="font-medium">Uncommitted changes</span>
            <span className="text-body text-stone-500">{uncommittedLabel ?? `in ${dirtyWorktrees} ${dirtyWorktrees === 1 ? "worktree" : "worktrees"}`}</span>
          </button>
        )}
        {!searching && totals?.map((t, k) => (
          <button key={t.key} data-total={t.key} data-lane={totalAt[k]?.lane} onClick={t.onClick} disabled={t.empty} aria-pressed={t.selected} style={{ height: ROW_H }} className={`flex w-full items-center gap-3 pl-2 pr-4 text-left ${t.selected ? "bg-teal-50 dark:bg-teal-900/30" : t.empty ? "" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <TotalCell lane={totalAt[k]?.lane ?? 0} width={graphW} joined={(totalAt[k]?.row ?? -1) >= 0} through={lead(-1 - k).map((l) => l.lane)} />
            <span className={`min-w-0 truncate font-medium ${t.empty ? "text-stone-500" : ""}`}>{t.label}</span>
            <span className="shrink-0 text-body text-stone-500">{t.detail}</span>
          </button>
        ))}
        {!searching && compare && (
          <button onClick={onCompare} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left ${compareSelected ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm border-2 border-stone-400" />
            <span className="font-medium">All changes</span>
            <span className="text-body text-stone-500">since <span className="font-mono">{compare.base}</span>{compare.ahead != null ? ` · ${compare.ahead} ${compare.ahead === 1 ? "commit" : "commits"}` : ""}</span>
          </button>
        )}
        {!searching && !loaded && error && <ErrorState title="Couldn't load commits" error={error} onRetry={() => load(0)} />}
        {!searching && !loaded && !error && <Loading />}
        {!searching && loaded && error && <div className="flex items-center gap-2 px-4 py-1.5 text-body text-red-700"><span className="selectable min-w-0 grow truncate">{errorParts(error).message}</span><button onClick={() => load(0)} className="underline">Retry</button></div>}
        {!searching && loaded && entries.length === 0 && dirtyWorktrees === 0 && <div className="p-4 text-body text-stone-500">No commits yet.</div>}
        {rows.map((e, i) => (
          <Fragment key={e.id}>
          {!searching && ownCount != null && i === ownCount && (
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
              else onSelect(selected === e.id && !picked?.size && !searching ? null : e.id);
            }}
            onContextMenu={(ev) => { if (onCommitMenu) { ev.preventDefault(); onCommitMenu(ev, e); } }}
            className={`flex cursor-pointer items-center gap-3 pl-2 pr-4 ${(picked?.size ? picked.has(e.id) : selected === e.id) ? "bg-teal-50 dark:bg-teal-900/30" : "hover:bg-stone-50 dark:hover:bg-stone-700/50"}`}
          >
            {searching ? <span className="w-2 shrink-0" /> : <GraphCell row={graph[i]} width={graphW} head={heads ? heads.has(e.id) : e.is_head} lead={totals ? lead(i) : undefined} />}
            {/* Earlier history is dimmed, but not the graph: see-through lane lines that
                overlap row to row would draw as dots at every row boundary. */}
            <div data-dim={!searching && ownCount != null && i >= ownCount && selected !== e.id && !picked?.has(e.id)} className={`flex min-w-0 grow items-center gap-3 ${!searching && ownCount != null && i >= ownCount && selected !== e.id && !picked?.has(e.id) ? "opacity-60" : ""}`}>
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
        {searching && results?.truncated && (
          <button onClick={() => search(q, results.entries.length)} className="m-2 rounded-md border border-stone-300 bg-white px-3 py-1 text-body dark:border-stone-600 dark:bg-stone-700">Load {PAGE} more</button>
        )}
        {!searching && truncated && (
          <button onClick={loadMore} disabled={loadingMore} className="m-2 rounded-md border border-stone-300 bg-white px-3 py-1 text-body disabled:opacity-50 dark:border-stone-600 dark:bg-stone-700">{loadingMore ? "Loading…" : `Load ${PAGE} more`}</button>
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

/// A total's dot: dashed, in its branch's lane and colour, with a dashed line
/// leaving downwards when there's a branch below to join.
function TotalCell({ lane, width, joined, through }: { lane: number; width: number; joined: boolean; through: number[] }) {
  const x = (l: number) => l * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  const dash = { strokeDasharray: "3 3" };
  return (
    <svg width={width} height={ROW_H + 2} viewBox={`0 -1 ${width} ${ROW_H + 2}`} className="-my-px shrink-0" aria-hidden="true">
      {through.filter((l) => l !== lane).map((l) => <line key={l} x1={x(l)} y1={-1} x2={x(l)} y2={ROW_H + 1} style={{ stroke: colorFor(l), ...dash }} strokeWidth={2} />)}
      {joined && <line x1={x(lane)} y1={mid} x2={x(lane)} y2={ROW_H + 1} style={{ stroke: colorFor(lane), ...dash }} strokeWidth={2} />}
      <circle cx={x(lane)} cy={mid} r={5} style={{ fill: "var(--graph-bg)", stroke: joined ? colorFor(lane) : "#a8a29e", ...dash }} strokeWidth={2} />
    </svg>
  );
}

function GraphCell({ row, width, head, lead }: { row: GraphRow; width: number; head: boolean; lead?: { lane: number; ends: boolean }[] }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2 + 2;
  // This commit's dot never leaves the visible lanes.
  const dotX = Math.min(x(row.lane), width - LANE_W / 2);
  const mid = ROW_H / 2;
  // Lines overrun the row by a pixel each way so rows never show a seam when zoomed.
  const T = -1;
  const B = ROW_H + 1;
  return (
    <svg width={width} height={ROW_H + 2} viewBox={`0 -1 ${width} ${ROW_H + 2}`} className="-my-px shrink-0" data-lane={row.lane} aria-hidden="true">
      {/* A total's dashed line, on its way down to the branch it sums up. Never over a real line. */}
      {lead?.filter((l) => (l.ends ? !row.top : l.lane !== row.lane && !row.through.includes(l.lane))).map((l) => <line key={`l${l.lane}`} x1={x(l.lane)} y1={T} x2={x(l.lane)} y2={l.ends ? mid : B} style={{ stroke: colorFor(l.lane), strokeDasharray: "3 3" }} strokeWidth={2} />)}
      {row.through.map((l) => <line key={`t${l}`} x1={x(l)} y1={T} x2={x(l)} y2={B} style={{ stroke: colorFor(l) }} strokeWidth={2} />)}
      {row.into.map((l) => <path key={`i${l}`} d={`M ${x(l)} ${T} C ${x(l)} ${mid} ${x(row.lane)} ${mid} ${x(row.lane)} ${mid}`} fill="none" style={{ stroke: colorFor(l) }} strokeWidth={2} />)}
      {row.top && <line x1={x(row.lane)} y1={T} x2={x(row.lane)} y2={mid} style={{ stroke: colorFor(row.lane) }} strokeWidth={2} />}
      {row.down.map((d, k) => d.from === d.to
        ? <line key={`d${k}`} x1={x(d.to)} y1={mid} x2={x(d.to)} y2={B} style={{ stroke: colorFor(d.to) }} strokeWidth={2} />
        : <path key={`d${k}`} d={`M ${x(d.from)} ${mid} C ${x(d.from)} ${ROW_H} ${x(d.to)} ${mid} ${x(d.to)} ${B}`} fill="none" style={{ stroke: colorFor(d.to) }} strokeWidth={2} />)}
      <circle cx={dotX} cy={mid} r={head ? 5 : 4} style={{ fill: head ? "var(--graph-bg)" : colorFor(row.lane), stroke: colorFor(row.lane) }} strokeWidth={2} />
    </svg>
  );
}
