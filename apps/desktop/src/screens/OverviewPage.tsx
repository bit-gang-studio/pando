import { useEffect, useState } from "react";
import { ago, api, changed, type BranchRow, type Overlap, type Overview, type PullRequest, type Relation, type RelLink } from "../lib/api";
import { navigate } from "../lib/routes";
import { folderName } from "../lib/worktrees";
import { ErrorState, Loading } from "../ui/State";
import { PrBadge } from "../ui/PrBadge";

type Props = {
  root: string;
  data: Overview;
  /// What's picked in the sidebar. All null: nothing is.
  worktree: string | null;
  branch: string | null;
  commit: string | null;
  prByBranch: Record<string, PullRequest>;
  overlaps: Overlap[];
  /// Goes up when a branch or a worktree's HEAD moved.
  refsTick: number;
};

const count = (n: number, one: string, then = "") => `${n} ${n === 1 ? one : `${one}s`}${then ? ` ${then}` : ""}`;
/// One dot per commit, so a longer line means more commits. Past this, a number says the rest.
const MAX_DOTS = 8;

/// How the picked branch stands next to the base and the branches around it:
/// where it forked, what it's built on, and what's built on top of it.
export function OverviewPage({ root, data, worktree, branch, commit, prByBranch, overlaps, refsTick }: Props) {
  const base = data.compare_base;
  const wtRow = worktree ? data.branches.find((b) => b.worktree?.path === worktree) ?? null : null;
  const detached = worktree ? data.detached.find((d) => d.worktree.path === worktree) ?? null : null;
  const row: BranchRow | null = wtRow ?? (branch ? data.branches.find((b) => b.branch.name === branch) ?? null : null);
  /// The branch or commit being looked at.
  const target = row?.branch.name ?? branch ?? detached?.worktree.head ?? commit ?? null;
  const [rel, setRel] = useState<Relation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The base has nothing to be compared to: it's what the others are compared to.
  const isBase = !!target && !!base && (target === base || (!!row && sameBranch(row.branch.name, base, data)));
  useEffect(() => {
    if (!target || !base || isBase) { setRel(null); return; }
    let live = true;
    api.relate(root, target, base)
      .then((r) => { if (live) { setRel(r); setError(null); } })
      .catch((e) => { if (live) { setRel(null); setError(String(e)); } });
    return () => { live = false; };
  }, [root, target, base, isBase, refsTick, attempt]);

  const head = (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stone-200 px-4 text-body dark:border-stone-700">
      <span className="font-medium">Overview</span>
      <span className="min-w-0 truncate text-stone-500">{target ? <>how <span className="font-mono">{label(target)}</span> stands next to {base ? <span className="font-mono">{base}</span> : "the base"} and the branches around it</> : "pick something in the sidebar"}</span>
    </div>
  );
  const wrap = (body: React.ReactNode) => <div className="flex min-h-0 min-w-0 grow flex-col bg-white dark:bg-stone-800">{head}{body}</div>;
  const say = (text: React.ReactNode) => wrap(<div className="flex grow items-center justify-center p-6 text-center text-body text-stone-500">{text}</div>);

  if (!target) return say("Pick a worktree or a branch in the sidebar to see what it's built on, and what's built on it.");
  if (!base) return say("This repository has no base branch yet, so there's nothing to compare to.");
  if (isBase) return say(<><span className="font-mono">{label(target)}</span> is the base. Every other branch is compared to it.</>);
  if (error) return wrap(<ErrorState title="Couldn't work this out" error={error} onRetry={() => setAttempt((a) => a + 1)} />);
  if (!rel || rel.target !== target) return wrap(<Loading />);

  const rowOf = (name: string) => data.branches.find((b) => b.branch.name === name) ?? null;
  const open = (l: { name: string }) => { const r = rowOf(l.name); navigate(r?.worktree ? { kind: "worktree", root, path: r.worktree.path } : { kind: "branch", root, name: l.name }); };
  const on = rel.below.at(-1)?.name ?? base;
  const shared = worktree ? overlaps.filter((o) => o.a === worktree || o.b === worktree) : [];
  const n = changed(wtRow?.status ?? detached?.status ?? null);
  const b = row?.branch;

  /// What's known about a branch on the line, in words.
  const facts = (l: RelLink): string[] => {
    const r = rowOf(l.name);
    return [
      l.remote ? "on the remote only, not checked out here" : r?.worktree ? `in ${folderName(r.worktree.path)}` : "no folder",
      ...(r?.merged ? [`already in ${r.merged_in ?? base}`] : []),
    ];
  };
  const rung = (l: RelLink, depth: number, tone: "below" | "above") => (
    <li key={l.name} data-link={l.name} style={{ paddingLeft: depth * 28 }} className="flex items-center gap-2 py-1.5">
      <Elbow />
      <Dots n={l.commits} tone={tone === "below" ? "bg-stone-500" : "bg-stone-300 dark:bg-stone-600"} />
      <button onClick={() => open(l)} title={`Show ${l.name}`} className="min-w-0 truncate font-mono text-body font-medium hover:underline">{l.name}</button>
      {prByBranch[l.name] && <PrBadge pr={prByBranch[l.name]} />}
      <span className="min-w-0 truncate text-label text-stone-500">{[count(l.commits, "commit"), ...facts(l)].join(" · ")}</span>
    </li>
  );
  const depthOfTarget = rel.below.length + 1;

  return wrap(
    <div className="min-h-0 grow overflow-auto px-5 py-4">
      <p data-summary className="max-w-3xl text-body">
        <span className="font-mono font-medium">{label(target)}</span>{" "}
        {rel.fork === null ? <>shares no history with <span className="font-mono">{base}</span>.</>
          : rel.below.length ? <>is built on <span className="font-mono">{on}</span>, {rel.below.length > 1 ? "which is built on others that lead" : "which leads"} back to <span className="font-mono">{base}</span>.</>
          : <>is built straight on <span className="font-mono">{base}</span>.</>}
        {rel.fork && <> {rel.behind ? <><span className="font-mono">{base}</span> has moved on by {count(rel.behind, "commit")} since.</> : <>Nothing new on <span className="font-mono">{base}</span> since.</>}</>}
      </p>

      <ol aria-label={`What ${label(target)} is built on`} className="mt-4">
        <li data-link={base} className="flex items-center gap-2 py-1.5">
          <button onClick={() => navigate({ kind: "branch", root, name: base })} title={`Show ${base}`} className="shrink-0 rounded bg-stone-800 px-2 py-0.5 font-mono text-body font-medium text-white dark:bg-stone-200 dark:text-stone-900">{base}</button>
          <span className="text-label text-stone-500">the base</span>
          <span className="h-0 w-6 border-t-2 border-stone-400 dark:border-stone-500" />
          <span title={rel.fork ? `${rel.fork.summary}\n${rel.fork.id}` : undefined} className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-stone-500 bg-white dark:bg-stone-800" />
          <span className="shrink-0 text-label text-stone-500">{rel.fork ? `forked here ${ago(rel.fork.time)}` : "no shared commit"}</span>
          {rel.behind > 0 && <>
            <Dots n={rel.behind} tone="bg-amber-500" />
            <span className="min-w-0 truncate text-label text-amber-800 dark:text-amber-300">{count(rel.behind, "commit")} on {base} since, that {label(target)} doesn't have</span>
          </>}
        </li>
        {rel.below.map((l, i) => rung(l, i + 1, "below"))}
        <li data-link={target} data-selected style={{ paddingLeft: depthOfTarget * 28 }} className="py-1.5">
          <div className="-ml-2 rounded-md bg-teal-50 px-2 py-1.5 dark:bg-teal-900/30">
            <div className="flex items-center gap-2">
              <Elbow />
              <Dots n={rel.own} tone="bg-teal-600" />
              <span className="min-w-0 truncate font-mono text-body font-medium">{label(target)}</span>
              {b && prByBranch[b.name] && <PrBadge pr={prByBranch[b.name]} />}
              <span className="shrink-0 rounded border border-teal-600 px-1 text-label text-teal-700 dark:text-teal-300">selected</span>
              <span className="min-w-0 truncate text-label text-stone-500">{rel.own ? count(rel.own, "commit", "of its own") : "no commits of its own yet"}</span>
            </div>
            <ul aria-label="Where it is" className="ml-[22px] mt-1 space-y-0.5 text-label text-stone-600 dark:text-stone-300">
              <li>{worktree ? <>Folder: <span className="font-mono">{folderName(worktree)}</span>{data.status_loaded ? (n ? <> · <span className="text-amber-800 dark:text-amber-300">{count(n, "file", "to commit")}</span></> : " · nothing to commit") : ""}</> : row?.worktree ? <>Folder: <span className="font-mono">{folderName(row.worktree.path)}</span></> : "No folder: not checked out in any worktree."}</li>
              {b && <li>Remote: {!b.upstream ? "not pushed yet." : b.upstream_rewritten ? <>rewritten here; <span className="font-mono">{b.upstream}</span> needs a force push.</> : !(b.ahead || b.behind) ? <>in step with <span className="font-mono">{b.upstream}</span>.</> : <>{[b.ahead ? count(b.ahead, "commit", "to push") : "", b.behind ? count(b.behind, "commit", "to pull") : ""].filter(Boolean).join(" · ")} (<span className="font-mono">{b.upstream}</span>).</>}</li>}
              {!b && <li>No branch: this is a commit on its own.</li>}
              {row?.merged && <li className="text-teal-700 dark:text-teal-400">Already in {row.merged_in ?? base}.</li>}
            </ul>
          </div>
        </li>
        {rel.above.map((l) => rung(l, depthOfTarget + 1, "above"))}
      </ol>

      <div className="mt-4 max-w-3xl space-y-1.5 text-body">
        {rel.below.length > 0 && <p data-note="below">If <span className="font-mono">{on}</span> changes, <span className="font-mono">{label(target)}</span> has to follow it.</p>}
        {rel.above.length > 0 && <p data-note="above">{rel.above.length === 1 ? "1 branch is" : `${rel.above.length} branches are`} built on top of this one. If you rewrite its commits, {rel.above.length === 1 ? "it has" : "they have"} to follow.</p>}
        {shared.map((o) => {
          const other = o.a === worktree ? o.b : o.a;
          return (
            <p key={other} data-note="shared" className="text-amber-800 dark:text-amber-300">
              ⚠ Changes {count(o.files.length, "file")} that <button onClick={() => navigate({ kind: "worktree", root, path: other })} className="font-mono underline">{folderName(other)}</button> also changes: <span className="font-mono text-label">{o.files.slice(0, 4).join(", ")}{o.files.length > 4 ? ` and ${o.files.length - 4} more` : ""}</span>
            </p>
          );
        })}
      </div>
    </div>,
  );
}

/// A commit id reads better short.
const label = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? `commit ${rev.slice(0, 7)}` : rev);

/// `name` is the base, or the local branch that goes with a remote base.
function sameBranch(name: string, base: string, data: Overview): boolean {
  if (name === base) return true;
  const isLocal = data.branches.some((b) => b.branch.name === base);
  const b = data.branches.find((x) => x.branch.name === name)?.branch;
  // The local copy of a remote base, exactly in step with it.
  return !isLocal && base.split("/").slice(1).join("/") === name && b?.upstream === base && !b.ahead && !b.behind;
}

function Elbow() {
  return <span aria-hidden className="h-3 w-3 shrink-0 -translate-y-1 rounded-bl border-b-2 border-l-2 border-stone-400 dark:border-stone-500" />;
}

function Dots({ n, tone }: { n: number; tone: string }) {
  const shown = Math.min(n, MAX_DOTS);
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {n === 0 && <span className="h-0 w-4 border-t-2 border-dotted border-stone-300 dark:border-stone-600" />}
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className="flex items-center"><span className="h-0 w-2 border-t-2 border-stone-300 dark:border-stone-600" /><span className={`h-2 w-2 rounded-full ${tone}`} /></span>
      ))}
      {n > shown && <span className="ml-1 text-label text-stone-500">+{n - shown}</span>}
    </span>
  );
}
