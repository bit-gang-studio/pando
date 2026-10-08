import { changed, type Overview, type Summary } from "./api";

type DotInput = { status: Summary | null; missing: boolean; isMain: boolean; loaded: boolean };

/// The one visual rule: a dot means a worktree has it checked out. Its colour is its state.
export function dot({ status, missing, isMain, loaded }: DotInput): { cls: string; tip: string } {
  if (!loaded && !missing) return { cls: "bg-stone-300 dark:bg-stone-600", tip: "Checking for changes…" };
  if (missing) return { cls: "bg-red-700", tip: "Folder is missing" };
  if ((status?.conflicts ?? 0) > 0) return { cls: "bg-red-700", tip: "Has conflicts" };
  if (changed(status) > 0) return { cls: "bg-amber-700", tip: "Has uncommitted changes" };
  return isMain ? { cls: "bg-stone-400", tip: "Main worktree, clean" } : { cls: "bg-teal-700", tip: "Clean" };
}

/// Every worktree as a choice for "which worktree?" pickers.
export function worktreeOptions(data: Overview | null) {
  return [
    ...(data?.branches.filter((b) => b.worktree).map((b) => ({ value: b.worktree!.path, label: b.branch.name + (b.is_main_worktree ? " (main worktree)" : "") })) ?? []),
    ...(data?.detached.map((d) => ({ value: d.worktree.path, label: `detached at ${d.worktree.head?.slice(0, 7)}` })) ?? []),
  ];
}

/// The worktree's folder name: the last part of its path.
export const folderName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

/// A path the way a shell shows it: "~" for the home folder.
export function tilde(path: string, home: string): string {
  const h = home.replace(/[/\\]+$/, "");
  return h && (path === h || path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) ? `~${path.slice(h.length)}` : path;
}
