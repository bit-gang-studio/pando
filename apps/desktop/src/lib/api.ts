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
  /// Ahead and behind because it was rewritten here: force push, don't pull.
  upstream_rewritten: boolean;
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
  merged: boolean;
};
export type DetachedRow = { worktree: Worktree; is_main_worktree: boolean; status: Summary | null };
export type Overview = { repo: Repo; base: string | null; branches: BranchRow[]; detached: DetachedRow[]; remote_only: RemoteBranch[]; status_loaded: boolean; compare_base: string | null; fetched_at: number | null; /** Changes when any ref or worktree HEAD moves. */ refs_key?: string };

export type CreateWorktree = { branch: string; base: string | null; path: string | null; existing_branch: boolean };
export type Created = { worktree: Worktree };

export type FileStatus = { path: string; orig_path: string | null; staged: string | null; unstaged: string | null; untracked: boolean; conflicted: boolean };
export type LineKind = "context" | "add" | "del";
export type DiffLine = { kind: LineKind; old_no: number | null; new_no: number | null; text: string; no_newline: boolean };
export type Hunk = { header: string; old_start: number; old_count: number; new_start: number; new_count: number; lines: DiffLine[] };
export type FileDiff = { path: string; staged: boolean; binary: boolean; new_file: boolean; hunks: Hunk[]; added: number; deleted: number };

export type Operation = { kind: "rebase" | "merge" | "cherry_pick" | "revert"; applied: number; total: number; head_label: string; incoming_label: string; conflicted: string[]; counts: Record<string, number>; resolved: string[]; resolved_by_you: string[] };
export type Part = { kind: "text"; text: string } | { kind: "conflict"; ours: string; base: string | null; theirs: string };
export type Side = "ours" | "theirs" | "both";
export type ConflictFile = { path: string; ours: string; theirs: string; base: string | null; working: string; binary: boolean; parts: Part[]; deleted: "ours" | "theirs" | null };
export type Choice = { kind: "ours" | "theirs" | "both" | "base" } | { kind: "text"; text: string };

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
export type Range = { older: string; newer: string; base: string; ancestor: boolean; commits: string[]; count: number; added: number; deleted: number; files: FileChange[] };
export type Rewritten = { branch: string; old_tip: string; new_tip: string; paused: boolean };
export type Compare = { base: string; head: string; ahead: number; behind: number; merge_base: string | null; added: number; deleted: number; files: FileChange[] };

export type Preflight = {
  branch: string; base: string; base_local: string; clean: boolean; ahead: number; behind: number;
  conflict_predicted: boolean; conflict_files: string[]; base_checked_out_in: string | null; base_worktree_clean: boolean | null;
  has_upstream: boolean; last_summary: string | null; uncommitted: number;
  problems: string[];
};
export type MergePlan = {
  branch: string; base: string; strategy: "merge_commit" | "squash" | "rebase"; message: string | null;
};
export type Stash = { index: number; message: string; branch: string | null; time: number };
export type Applied = "done" | "paused";
export type RemoteRepo = { name: string; description: string; private: boolean; url: string; updated_at: string };
export type Checks = "passing" | "failing" | "pending" | "none";
export type PullRequest = { number: number; title: string; author: string; draft: boolean; head: string; base: string; from_fork: boolean; url: string; checks: Checks; review: string; updated_at: string };
/// `ok` with the list, or why there's none (then the app shows nothing).
export type PrDraft = { title: string; body: string; commits: number };
export type NewPullRequest = { branch: string; base: string; title: string; body: string; draft: boolean };
export type PullRequests = { state: "ok"; prs: PullRequest[] } | { state: "no_gh" } | { state: "signed_out" } | { state: "not_git_hub" };
export type Overlap = { a: string; b: string; files: string[] };
export type Removed = { path: string; branch: string | null; head: string | null; snapshot: string | null };
export type Tag = { name: string; target: string; object: string; annotated: boolean; time: number; summary: string };
export type BackupKind = "branch" | "discard" | "remove_worktree" | "restore" | "stash";
export type Backup = { refname: string; kind: BackupKind; branch: string | null; id: string; time: number; files: string[]; branch_exists: boolean };

export type Step = { name: string; ok: boolean; output: string };
export type MergeResult = { merged: boolean; steps: Step[]; backup_refs: string[] };


// ---- calls -------------------------------------------------------------------

export const api = {
  /// Folders the OS won't let Pando read. Run before any git.
  accessCheck: (paths: string[]) => invoke<string[]>("access_check", { paths }),
  reposList: () => invoke<UserConfig>("repos_list"),
  reposAdd: (path: string) => invoke<UserConfig>("repos_add", { path }),
  reposRemove: (path: string) => invoke<UserConfig>("repos_remove", { path }),

  watchRepo: (root: string, worktrees: string[]) => invoke<void>("watch_repo", { root, worktrees }),
  /// `quick` skips git status (fast on big repos); every status is then null.
  overview: (root: string, quick = false) => invoke<Overview>("overview_load", { root, quick }),
  fetchAll: (root: string) => invoke<void>("fetch_all", { root }),
  branchCreate: (root: string, name: string, base: string | null) => invoke<void>("branch_create", { root, name, base }),
  branchPush: (root: string, name: string) => invoke<void>("branch_push", { root, name }),
  branchPull: (worktree: string) => invoke<void>("branch_pull", { worktree }),
  branchDelete: (root: string, name: string, remote: boolean) => invoke<void>("branch_delete", { root, name, remote }),
  branchDeleteRemote: (root: string, name: string) => invoke<void>("branch_delete_remote", { root, name }),
  branchCreateAndSwitch: (path: string, name: string) => invoke<void>("branch_create_and_switch", { path, name }),
  branchSwitch: (root: string, name: string) => invoke<void>("branch_switch", { root, name }),
  worktreeSwitch: (root: string, path: string, name: string) => invoke<string | null>("worktree_switch", { root, path, name }),
  branchRename: (root: string, old: string, new_: string) => invoke<void>("branch_rename", { root, old, new: new_ }),
  branchSetUpstream: (root: string, name: string, upstream: string) => invoke<void>("branch_set_upstream", { root, name, upstream }),
  worktreeMove: (root: string, from: string, to: string) => invoke<void>("worktree_move", { root, from, to }),
  worktreeLock: (root: string, path: string, locked: boolean) => invoke<void>("worktree_lock", { root, path, locked }),
  worktreePrune: (root: string) => invoke<number>("worktree_prune", { root }),
  worktreeRepair: (root: string, path: string) => invoke<void>("worktree_repair", { root, path }),
  cherryPick: (root: string, worktree: string, id: string) => invoke<Applied>("commit_cherry_pick", { root, worktree, id }),
  revert: (root: string, worktree: string, id: string) => invoke<Applied>("commit_revert", { root, worktree, id }),
  tagCreate: (root: string, name: string, target: string, message: string | null, push: boolean) => invoke<void>("tag_create", { root, name, target, message, push }),
  tagDelete: (root: string, name: string) => invoke<void>("tag_delete", { root, name }),
  tagList: (root: string) => invoke<Tag[]>("tag_list", { root }),
  tagRestore: (root: string, name: string, object: string) => invoke<void>("tag_restore", { root, name, object }),
  tagPush: (root: string, name: string) => invoke<void>("tag_push", { root, name }),
  remoteRepos: () => invoke<RemoteRepo[] | null>("remote_repos"),
  repoClone: (source: string, parent: string) => invoke<UserConfig>("repo_clone", { source, parent }),
  overlaps: (root: string) => invoke<Overlap[]>("overlaps", { root }),
  prsList: (root: string) => invoke<PullRequests>("prs_list", { root }),
  prDraft: (root: string, branch: string, base: string) => invoke<PrDraft>("pr_draft", { root, branch, base }),
  prCreate: (root: string, req: NewPullRequest) => invoke<string>("pr_create", { root, req }),
  prAddWorktree: (root: string, pr: PullRequest) => invoke<Created>("pr_add_worktree", { root, pr }),
  backupsList: (root: string) => invoke<Backup[]>("backups_list", { root }),
  backupRestoreBranch: (root: string, refname: string) => invoke<void>("backup_restore_branch", { root, refname }),
  backupRestoreFiles: (root: string, refname: string, worktree: string) => invoke<void>("backup_restore_files", { root, refname, worktree }),
  backupDelete: (root: string, refname: string) => invoke<void>("backup_delete", { root, refname }),
  stashList: (root: string) => invoke<Stash[]>("stash_list", { root }),
  stashSave: (worktree: string, message: string | null) => invoke<boolean>("stash_save", { worktree, message }),
  stashApply: (worktree: string, index: number, pop: boolean) => invoke<void>("stash_apply", { worktree, index, pop }),
  stashDrop: (root: string, index: number) => invoke<string>("stash_drop", { root, index }),
  stashRestore: (root: string, kept: string, message: string) => invoke<void>("stash_restore", { root, kept, message }),
  worktreePathPreview: (root: string, branch: string) => invoke<string>("worktree_path_preview", { root, branch }),
  worktreeAdd: (root: string, req: CreateWorktree) => invoke<Created>("worktree_add", { root, req }),
  worktreeRemove: (root: string, path: string, force: boolean) => invoke<Removed>("worktree_remove", { root, path, force }),
  worktreeUndoRemove: (root: string, removed: Removed) => invoke<void>("worktree_undo_remove", { root, removed }),
  terminalName: () => invoke<string | null>("terminal_name"),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
  editorNames: () => invoke<string[]>("editor_names"),
  openEditor: (name: string, path: string) => invoke<void>("open_editor", { name, path }),

  log: (root: string, branch: string | null, skip: number, limit: number) => invoke<Log>("log_list", { root, branch, skip, limit }),
  logSearch: (root: string, branch: string | null, query: string, skip: number, limit: number) => invoke<Log>("log_search", { root, branch, query, skip, limit }),
  commitDiff: (root: string, id: string) => invoke<CommitDiff>("commit_diff", { root, id }),
  compare: (root: string, base: string, head: string) => invoke<Compare>("compare", { root, base, head }),
  branchForcePush: (root: string, name: string) => invoke<void>("branch_force_push", { root, name }),
  rewritePushed: (root: string, branch: string) => invoke<string[]>("rewrite_pushed", { root, branch }),
  rewriteEditable: (root: string, branch: string) => invoke<string[]>("rewrite_editable", { root, branch }),
  commitReword: (root: string, branch: string, id: string, message: string) => invoke<Rewritten>("commit_reword", { root, branch, id, message }),
  commitSquash: (root: string, branch: string, older: string, newer: string, message: string) => invoke<Rewritten>("commit_squash", { root, branch, older, newer, message }),
  commitDrop: (root: string, branch: string, id: string) => invoke<Rewritten>("commit_drop", { root, branch, id }),
  rewriteUndo: (root: string, branch: string, from: string, to: string) => invoke<void>("rewrite_undo", { root, branch, from, to }),
  commitRange: (root: string, older: string, newer: string) => invoke<Range>("commit_range", { root, older, newer }),
  commitRangeFileDiff: (root: string, base: string, newer: string, path: string) => invoke<FileDiff>("commit_range_file_diff", { root, base, newer, path }),
  compareFileDiff: (root: string, base: string, head: string, path: string) => invoke<FileDiff>("compare_file_diff", { root, base, head, path }),
  commitFileDiff: (root: string, id: string, path: string) => invoke<FileDiff>("commit_file_diff", { root, id, path }),
  detail: (root: string, path: string) => invoke<Detail>("detail_load", { root, path }),
  diffFile: (worktree: string, path: string, staged: boolean, untracked: boolean) => invoke<FileDiff>("diff_file", { worktree, path, staged, untracked }),
  stagePaths: (worktree: string, paths: string[]) => invoke<void>("stage_paths", { worktree, paths }),
  unstagePaths: (worktree: string, paths: string[]) => invoke<void>("unstage_paths", { worktree, paths }),
  stageAll: (worktree: string) => invoke<void>("stage_all", { worktree }),
  unstageAll: (worktree: string) => invoke<void>("unstage_all", { worktree }),
  discardPaths: (worktree: string, paths: string[], untracked: string[]) => invoke<string | null>("discard_paths", { worktree, paths, untracked }),
  applyLines: (worktree: string, path: string, hunk: Hunk, lines: number[], reverse: boolean) => invoke<void>("apply_lines", { worktree, path, hunk, lines, reverse }),
  applyHunk: (worktree: string, path: string, hunk: Hunk, reverse: boolean) => invoke<void>("apply_hunk", { worktree, path, hunk, reverse }),
  commitCreate: (worktree: string, message: string, amend: boolean) => invoke<string>("commit_create", { worktree, message, amend }),
  syncRebase: (root: string, worktree: string, branch: string, base: string) => invoke<SyncResult>("sync_rebase", { root, worktree, branch, base }),

  mergePreflight: (root: string, path: string | null, branch: string) => invoke<Preflight>("merge_preflight", { root, path, branch }),
  mergeRun: (root: string, path: string | null, plan: MergePlan) => invoke<MergeResult>("merge_run", { root, path, plan }),

  conflictFile: (worktree: string, path: string) => invoke<ConflictFile>("conflict_file", { worktree, path }),
  conflictTake: (worktree: string, path: string, side: Side) => invoke<void>("conflict_take", { worktree, path, side }),
  conflictChoose: (worktree: string, path: string, choices: Choice[]) => invoke<void>("conflict_choose", { worktree, path, choices }),
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
