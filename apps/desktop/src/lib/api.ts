import { invoke } from "@tauri-apps/api/core";

// ---- types (mirror crates/core) -------------------------------------------

export type Repo = { root: string; common_git_dir: string; default_branch: string | null; bare: boolean };
export type UserConfig = { repos: string[] };

export type WorktreeKind = "main" | "linked";
export type Worktree = {
  path: string;
  kind: WorktreeKind;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};

export type CommitInfo = { id: string; summary: string; author: string; time: number };
export type Branch = {
  name: string;
  tip: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  checked_out_in: string | null;
  last_commit: CommitInfo | null;
};
export type RemoteBranch = { name: string; remote: string; short: string; tip: string; tracked: boolean; last_commit: CommitInfo | null };

export type Summary = { staged: number; unstaged: number; untracked: number; conflicts: number };
export type BranchRow = {
  branch: Branch;
  worktree: Worktree | null;
  is_main_worktree: boolean;
  status: Summary | null;
  ahead_of_base: number | null;
  stale: boolean;
};
export type DetachedRow = { worktree: Worktree; is_main_worktree: boolean; status: Summary | null };
export type Overview = { repo: Repo; base: string | null; branches: BranchRow[]; detached: DetachedRow[]; remote_only: RemoteBranch[] };

export type CreateWorktree = { branch: string; base: string | null; path: string | null; existing_branch: boolean };
export type Created = { worktree: Worktree };

export type FileStatus = { path: string; orig_path: string | null; staged: string | null; unstaged: string | null; untracked: boolean; conflicted: boolean };
export type LineKind = "context" | "add" | "del";
export type DiffLine = { kind: LineKind; old_no: number | null; new_no: number | null; text: string; no_newline: boolean };
export type Hunk = { header: string; old_start: number; old_count: number; new_start: number; new_count: number; lines: DiffLine[] };
export type FileDiff = { path: string; staged: boolean; binary: boolean; new_file: boolean; hunks: Hunk[]; added: number; deleted: number };

export type Operation = { kind: "rebase" | "merge" | "cherry_pick"; applied: number; total: number; head_label: string; incoming_label: string; conflicted: string[]; resolved: string[] };
export type ConflictFile = { path: string; ours: string; theirs: string; base: string | null; working: string; binary: boolean };

export type Detail = {
  repo: Repo;
  worktree: Worktree;
  branch: Branch | null;
  files: FileStatus[];
  ahead: CommitInfo[];
  base_branch: string | null;
  head_summary: string | null;
  operation: Operation | null;
};

export type SyncResult = { ok: boolean; conflicts: string[]; message: string };

export type LogEntry = { id: string; parents: string[]; author: string; time: number; summary: string; refs: string[]; is_head: boolean };
export type Log = { entries: LogEntry[]; truncated: boolean };
export type FileChange = { path: string; added: number; deleted: number };
export type CommitDiff = { commit: CommitInfo; message: string; files: FileChange[] };

export type Preflight = {
  branch: string; base: string; base_local: string; clean: boolean; ahead: number; behind: number;
  conflict_predicted: boolean; conflict_files: string[]; base_checked_out_in: string | null; base_worktree_clean: boolean | null;
  has_upstream: boolean; last_summary: string | null; uncommitted: number;
  problems: string[];
};
export type MergePlan = {
  branch: string; base: string; strategy: "merge_commit" | "squash" | "rebase"; message: string | null;
  push_base: boolean; delete_branch: boolean;
};
export type Step = { name: string; ok: boolean; output: string };
export type MergeResult = { landed: boolean; steps: Step[]; backup_ref: string | null };


// ---- calls -------------------------------------------------------------------

export const api = {
  version: () => invoke<string>("version"),
  reposList: () => invoke<UserConfig>("repos_list"),
  reposAdd: (path: string) => invoke<UserConfig>("repos_add", { path }),
  reposRemove: (path: string) => invoke<UserConfig>("repos_remove", { path }),
  userConfigSave: (config: UserConfig) => invoke<void>("user_config_save", { config }),

  overview: (root: string) => invoke<Overview>("overview_load", { root }),
  fetchAll: (root: string) => invoke<void>("fetch_all", { root }),
  branchCreate: (root: string, name: string, base: string | null) => invoke<void>("branch_create", { root, name, base }),
  branchPush: (root: string, name: string) => invoke<void>("branch_push", { root, name }),
  branchPull: (worktree: string) => invoke<void>("branch_pull", { worktree }),
  branchDelete: (root: string, name: string, remote: boolean) => invoke<void>("branch_delete", { root, name, remote }),
  worktreePathPreview: (root: string, branch: string) => invoke<string>("worktree_path_preview", { root, branch }),
  worktreeAdd: (root: string, req: CreateWorktree) => invoke<Created>("worktree_add", { root, req }),
  worktreeRemove: (root: string, path: string, force: boolean) => invoke<void>("worktree_remove", { root, path, force }),

  log: (root: string, branch: string | null, skip: number, limit: number) => invoke<Log>("log_list", { root, branch, skip, limit }),
  commitDiff: (root: string, id: string) => invoke<CommitDiff>("commit_diff", { root, id }),
  commitFileDiff: (root: string, id: string, path: string) => invoke<FileDiff>("commit_file_diff", { root, id, path }),
  detail: (root: string, path: string) => invoke<Detail>("detail_load", { root, path }),
  diffFile: (worktree: string, path: string, staged: boolean, untracked: boolean) => invoke<FileDiff>("diff_file", { worktree, path, staged, untracked }),
  stagePaths: (worktree: string, paths: string[]) => invoke<void>("stage_paths", { worktree, paths }),
  unstagePaths: (worktree: string, paths: string[]) => invoke<void>("unstage_paths", { worktree, paths }),
  stageAll: (worktree: string) => invoke<void>("stage_all", { worktree }),
  unstageAll: (worktree: string) => invoke<void>("unstage_all", { worktree }),
  discardPaths: (worktree: string, paths: string[], untracked: string[]) => invoke<void>("discard_paths", { worktree, paths, untracked }),
  applyHunk: (worktree: string, path: string, hunk: Hunk, reverse: boolean) => invoke<void>("apply_hunk", { worktree, path, hunk, reverse }),
  commitCreate: (worktree: string, message: string, amend: boolean) => invoke<string>("commit_create", { worktree, message, amend }),
  syncRebase: (root: string, worktree: string, branch: string, base: string) => invoke<SyncResult>("sync_rebase", { root, worktree, branch, base }),

  mergePreflight: (root: string, path: string, branch: string) => invoke<Preflight>("merge_preflight", { root, path, branch }),
  mergeRun: (root: string, path: string, plan: MergePlan) => invoke<MergeResult>("merge_run", { root, path, plan }),

  conflictFile: (worktree: string, path: string) => invoke<ConflictFile>("conflict_file", { worktree, path }),
  conflictTake: (worktree: string, path: string, side: "ours" | "theirs" | "both") => invoke<void>("conflict_take", { worktree, path, side }),
  conflictResolve: (worktree: string, path: string, content: string) => invoke<void>("conflict_resolve", { worktree, path, content }),
  conflictReset: (worktree: string, path: string) => invoke<void>("conflict_reset", { worktree, path }),
  opContinue: (worktree: string) => invoke<Operation | null>("op_continue", { worktree }),
  opAbort: (worktree: string) => invoke<void>("op_abort", { worktree }),

};

// ---- helpers -----------------------------------------------------------------

export function changed(s: Summary | null): number {
  return s ? s.staged + s.unstaged + s.untracked + s.conflicts : 0;
}

export function repoName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

export function ago(unix: number | null): string {
  if (!unix) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
