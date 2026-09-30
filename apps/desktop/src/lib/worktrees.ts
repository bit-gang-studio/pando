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

/// Same rule as core's branch_slug: what Pando names a worktree folder after.
const slug = (branch: string) => branch.toLowerCase().replace(/[^\p{L}\p{N}._]+/gu, "-").replace(/^-+|-+$/g, "");

/// The folder's name, when it no longer says which branch is in it
/// (the branch was switched inside the worktree, or the folder was named by hand).
export function folderHint(path: string, branch: string | null): string | null {
  const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
  return branch && name.toLowerCase().includes(slug(branch)) ? null : name;
}
