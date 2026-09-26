import { ago, changed, type Row } from "../lib/api";
import { Chip } from "./Chip";

type Props = {
  row: Row;
  onReview: () => void;
  onLand?: () => void;
  onOpen: () => void;
  onRemove: () => void;
};

export function WorktreeRow({ row, onReview, onLand, onOpen, onRemove }: Props) {
  const { worktree: w, branch: b, status } = row;
  const n = changed(status);
  const conflicts = status?.conflicts ?? 0;
  const dot = w.prunable || conflicts
    ? "bg-red-700"
    : n > 0 || (b?.behind ?? 0) > 0
      ? "bg-amber-700"
      : w.kind === "linked"
        ? "bg-teal-700"
        : "bg-stone-400";
  const isMain = w.kind === "main";

  return (
    <div onClick={onReview} className={`grid cursor-pointer grid-cols-[16px_minmax(200px,1fr)_minmax(160px,1fr)_90px_80px_minmax(0,auto)] items-center gap-3 rounded-lg border px-3 py-2.5 hover:border-stone-400 ${isMain ? "border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-800/60" : "border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-800"}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <div className="min-w-0">
        <div className="truncate font-mono text-[13px] font-medium">
          {w.branch ?? (w.detached ? "(detached)" : "(bare)")}
          {isMain && <span className="ml-2 font-sans text-xs font-normal text-stone-500">main worktree</span>}
        </div>
        <div className="truncate text-xs text-stone-500" title={w.path}>
          {b?.upstream ? `tracks ${b.upstream} · ` : ""}{w.path}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {w.prunable ? (
          <Chip tone="red">missing on disk</Chip>
        ) : status ? (
          n === 0 ? <Chip>clean</Chip> : <Chip tone="amber">{n} changed</Chip>
        ) : null}
        {conflicts > 0 && <Chip tone="red">{conflicts} conflicts</Chip>}
        {b && b.ahead != null && b.behind != null && (
          <Chip tone={b.behind > 0 ? "amber" : "grey"}>↑{b.ahead} ↓{b.behind}</Chip>
        )}
        {w.locked != null && <Chip>locked{w.locked ? `: ${w.locked}` : ""}</Chip>}
      </div>
      <div>{row.port != null && <Chip mono>:{row.port}</Chip>}</div>
      <div className="text-xs text-stone-500">{ago(row.last_commit_at)}</div>
      <div className="flex flex-wrap justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button onClick={onReview} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600">
          Review
        </button>
        <button onClick={onOpen} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600">
          Open
        </button>
        {onLand && (
          <button onClick={onLand} className="h-7 rounded-md border border-teal-700 bg-white px-2.5 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:bg-stone-700 dark:hover:bg-stone-600">
            Land
          </button>
        )}
        {!isMain && (
          <button onClick={onRemove} className="h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600">
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
