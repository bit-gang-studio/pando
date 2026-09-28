import type { Checks, PullRequest } from "../lib/api";

const MARK: Record<Checks, { sym: string; cls: string; tip: string }> = {
  passing: { sym: "✓", cls: "text-teal-700", tip: "Checks passing" },
  failing: { sym: "✕", cls: "text-red-700", tip: "Checks failing" },
  pending: { sym: "●", cls: "text-amber-700", tip: "Checks running" },
  none: { sym: "", cls: "", tip: "No checks" },
};

export function ChecksMark({ checks }: { checks: Checks }) {
  const m = MARK[checks];
  return m.sym ? <span title={m.tip} aria-label={m.tip} className={`shrink-0 text-label ${m.cls}`}>{m.sym}</span> : null;
}

/// "#475 ✓" next to a branch that has an open pull request.
export function PrBadge({ pr }: { pr: PullRequest }) {
  return (
    <span title={`#${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""} · ${MARK[pr.checks].tip}`} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-stone-200 px-1.5 py-px font-mono text-label text-stone-700 dark:bg-stone-700 dark:text-stone-200">
      #{pr.number}
      <ChecksMark checks={pr.checks} />
    </span>
  );
}
