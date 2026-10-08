import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Compare, type Overview } from "../lib/api";
import { navigate } from "../lib/routes";
import { folderName } from "../lib/worktrees";
import { BranchPicker, type PickBranch } from "../ui/BranchPicker";
import { SplitHandle, useSplit } from "../ui/Split";
import { ErrorState, Loading } from "../ui/State";
import { CommitDetail } from "./CommitDetail";
import { CommitLog, type Span } from "./CommitLog";

type Props = {
  root: string;
  data: Overview;
  /// What's picked in the sidebar: one side of the comparison.
  worktree: string | null;
  branch: string | null;
  commit: string | null;
  /// Goes up when a branch or a worktree's HEAD moved.
  refsTick: number;
};

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
/// A commit id reads better short.
const label = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? `commit ${rev.slice(0, 7)}` : rev);
/// What to compare with, remembered while the window is open, per repository.
const lastWith: Record<string, string> = {};

/// Two branches since they split: the commits only one of them has, in one
/// graph, with the commit where they split underneath.
export function ComparePage({ root, data, worktree, branch, commit, refsTick }: Props) {
  const split = useSplit("pando.split.graph.px", 300, "y", 120, 4000);
  const wtRow = worktree ? data.branches.find((b) => b.worktree?.path === worktree) ?? null : null;
  const detached = worktree ? data.detached.find((d) => d.worktree.path === worktree) ?? null : null;
  /// The picked side: a branch, or the commit a worktree with no branch sits on.
  const mine = wtRow?.branch.name ?? branch ?? detached?.worktree.head ?? commit ?? null;
  const [chosen, setChosen] = useState<string | null>(() => lastWith[root] ?? null);
  // The base is the usual thing to compare with. Not with itself.
  const other = chosen && chosen !== mine ? chosen : data.compare_base && data.compare_base !== mine ? data.compare_base : null;

  const [cmp, setCmp] = useState<{ mine: Compare; theirs: Compare } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setCmp(null); setError(null);
    if (!mine || !other) return;
    let live = true;
    // Each way round: what the picked side changed since the split, and what the other did.
    Promise.all([api.compare(root, other, mine), api.compare(root, mine, other)])
      .then(([a, b]) => { if (live) setCmp({ mine: a, theirs: b }); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [root, mine, other, refsTick, attempt]);

  // What's shown underneath: one commit, several picked together, or everything one side changed.
  const [sel, setSel] = useState<string | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [span, setSpan] = useState<Span | null>(null);
  const [spanIds, setSpanIds] = useState<string[] | null>(null);
  const [whole, setWhole] = useState<"mine" | "theirs" | null>(null);
  useEffect(() => { setSel(null); setFirst(null); setSpan(null); setSpanIds(null); setWhole(null); }, [root, mine, other]);
  const onLoaded = useCallback((id: string | null) => setFirst(id), []);
  const picked = useMemo(() => (span ? new Set(spanIds ?? [span.older, span.newer]) : undefined), [span, spanIds]);
  const pickSpan = (s: Span | null) => { setSpan(s); setSpanIds(null); setWhole(null); };

  const [picking, setPicking] = useState<{ x: number; y: number } | null>(null);
  const choices = useMemo<PickBranch[]>(() => {
    const local = data.branches.map((b) => ({ name: b.branch.name, note: b.worktree ? `in ${folderName(b.worktree.path)}` : undefined }));
    const remote = [...new Set([...data.branches.flatMap((b) => (b.branch.upstream ? [b.branch.upstream] : [])), ...data.remote_only.map((r) => r.name)])].map((name) => ({ name }));
    return [...local, ...remote].map((c) => ({ ...c, where: c.name === mine ? "picked in the sidebar" : undefined }));
  }, [data, mine]);
  const choose = (name: string) => { lastWith[root] = name; setChosen(name); };
  /// The other side becomes the picked one, and this one what it's compared with.
  const swap = () => {
    if (!mine || !other) return;
    const r = data.branches.find((b) => b.branch.name === other);
    choose(mine);
    navigate(r?.worktree ? { kind: "worktree", root, path: r.worktree.path } : { kind: "branch", root, name: other });
  };

  const side = "rounded px-1.5 py-0.5 font-mono text-body font-medium";
  const head = (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-stone-200 px-4 py-1 text-body dark:border-stone-700">
      <span className="font-medium">Compare</span>
      {mine ? <span className={`${side} bg-teal-50 dark:bg-teal-900/40`} title="Picked in the sidebar">{worktree ? `${folderName(worktree)} · ` : ""}{label(mine)}</span> : <span className="text-stone-500">pick a worktree or a branch in the sidebar</span>}
      {mine && <>
        <span className="text-stone-500">with</span>
        <button onClick={(e) => { const at = e.currentTarget.getBoundingClientRect(); setPicking({ x: at.left, y: at.bottom + 2 }); }} aria-haspopup="dialog" aria-label="Compare with" className={`${side} flex items-center gap-1 border border-stone-300 hover:bg-stone-100 dark:border-stone-600 dark:hover:bg-stone-700`}>
          {other ? label(other) : "choose a branch"}<span className="text-stone-400">▾</span>
        </button>
        {other && <button onClick={swap} title={`Pick ${label(other)} and compare it with ${label(mine)}`} className="rounded px-1.5 py-0.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-200">⇄ Swap</button>}
      </>}
      {picking && <BranchPicker x={picking.x} y={picking.y} label="Compare with" branches={choices} hint="Shows the commits each one has that the other doesn't, since they split." onPick={choose} onClose={() => setPicking(null)} />}
    </div>
  );
  const wrap = (body: React.ReactNode) => <div className="flex min-h-0 min-w-0 grow flex-col bg-white dark:bg-stone-800">{head}{body}</div>;
  const say = (text: React.ReactNode) => wrap(<div className="flex grow items-center justify-center p-6 text-center text-body text-stone-500">{text}</div>);

  if (!mine) return say("Pick a worktree or a branch in the sidebar, then choose what to compare it with.");
  if (!other) return say(<>Choose what to compare <span className="font-mono">{label(mine)}</span> with.</>);
  if (error) return wrap(<ErrorState title="Couldn't compare these" error={error} onRetry={() => setAttempt((a) => a + 1)} />);
  if (!cmp) return wrap(<Loading />);

  const { ahead, behind, merge_base: fork } = cmp.mine;
  const theirFiles = new Set(cmp.theirs.files.map((f) => f.path));
  const both = cmp.mine.files.map((f) => f.path).filter((p) => theirFiles.has(p));
  const shown = sel ?? first;
  const pickWhole = (which: "mine" | "theirs") => { pickSpan(null); setWhole(which); };
  /// One row per side that has commits: everything it changed since the split, as one diff.
  const totals = [
    ...(ahead ? [{ key: "mine", label: <>All changes on <span className="font-mono">{label(mine)}</span></>, detail: `since they split · ${count(ahead, "commit")}`, selected: whole === "mine", onClick: () => pickWhole("mine") }] : []),
    ...(behind ? [{ key: "theirs", label: <>All changes on <span className="font-mono">{label(other)}</span></>, detail: `since they split · ${count(behind, "commit")}`, selected: whole === "theirs", onClick: () => pickWhole("theirs") }] : []),
  ];
  /// A side with nothing new has no line in the graph. Say so, so nobody looks for it.
  const still = ahead > 0 && behind === 0 ? other : behind > 0 && ahead === 0 ? mine : null;

  return wrap(
    <div ref={split.box} className="flex min-h-0 min-w-0 grow flex-col">
      <div data-summary className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-stone-200 px-4 py-1.5 text-body text-stone-600 dark:border-stone-700 dark:text-stone-300">
        {fork === null ? <span>These two share no history.</span>
          : ahead === 0 && behind === 0 ? <span>These two are at the same commit. Nothing differs.</span>
          : <span>{count(ahead, "commit")} only on <span className="font-mono">{label(mine)}</span> <span className="text-stone-400">·</span> {count(behind, "commit")} only on <span className="font-mono">{label(other)}</span></span>}
        {fork !== null && still && <span data-still className="basis-full text-stone-500"><span className="font-mono">{label(still)}</span> hasn't moved since they split, so it has no line of its own below. Its newest commit is where they split.</span>}
        {both.length > 0 && <span data-both className="basis-full text-amber-800 dark:text-amber-300" title={both.join("\n")}>⚠ {count(both.length, "file")} changed on both sides: <span className="font-mono text-label">{both.slice(0, 4).join(", ")}{both.length > 4 ? ` and ${both.length - 4} more` : ""}</span>. A merge may conflict there.</span>}
      </div>
      <div style={{ height: split.size, flex: "0 0 auto" }} className="flex min-h-0 flex-col">
        <CommitLog
          root={root}
          scope={mine}
          title={<><span className="font-mono">{label(mine)}</span> and <span className="font-mono">{label(other)}</span> since they split</>}
          totals={totals}
          range={{ own: `${other}...${mine}`, rest: fork, restLabel: "Where they split, and the history they share" }}
          dirtyWorktrees={0}
          selected={whole || span ? null : shown}
          picked={picked}
          spanEnd={span?.other}
          onSpan={pickSpan}
          onSelect={(id) => { pickSpan(null); setSel(id); }}
          onUncommitted={() => {}}
          onLoaded={onLoaded}
          refreshKey={refsTick}
        />
      </div>
      <SplitHandle axis="y" onMouseDown={split.start} handleRef={split.handle} />
      <div className="flex min-h-0 min-w-0 grow">
        {whole ? <CommitDetail key={`whole-${whole}-${mine}-${other}`} root={root} compare={whole === "mine" ? { base: other, head: mine } : { base: mine, head: other }} onBack={() => setWhole(null)} />
          : span ? <CommitDetail key={`span-${span.older}-${span.newer}`} root={root} span={span} onRange={setSpanIds} onBack={() => pickSpan(null)} />
          : shown ? <CommitDetail root={root} id={shown} />
          : <div className="flex grow items-center justify-center text-body text-stone-500">Nothing has been committed on either one since they split.</div>}
      </div>
    </div>,
  );
}
