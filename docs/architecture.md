# Architecture

## Two nouns

- **Branch**: a git branch. Checked out in the main worktree, in a worktree, or nowhere.
- **Worktree**: a folder on disk with one branch checked out. Pando shows its status, commits ahead of the base, and lets you stage, commit, sync and merge.

## Layers

```
apps/desktop (Tauri 2 + React)     crates/cli (pando)
             \                        /
              crates/core (pando-core)
```

Core is the only place that touches git. Its API is plain serde request and response types. In v1 both apps link core in-process. A daemon or hosted version can wrap the same API later.

## Folder access

On macOS, Documents, Desktop, Downloads and iCloud are protected and the first read asks the user. The app runs `access::check` on every repo folder first, alone, before any git; if a folder is blocked it shows how to allow it and runs nothing else. Otherwise each parallel git command would ask separately.

## Git backend

- Mutations: the user's `git` CLI, porcelain and `-z` output. Hooks, credentials, signing, and fsmonitor keep working.
- Reads: gix (gitoxide) in-process.
- Status: `git status --porcelain=v2 -z` with `-c core.untrackedCache=true`. The repo page loads without status first (`overview::load_quick`), then with it.
- Fetch runs quietly on open and every 5 minutes while the window is in use. Failures stay silent; the Fetch button shows them.
- File watching: `watch` watches the git dir and every worktree folder, ignores what git ignores, and the app refreshes on change. It falls back to polling.
- No libgit2. Floor is git 2.39.

## Screens and core calls

- Repositories: `user_config` repo list, plus `overview::load` per repo for counts.
- Repo page: `overview::load` feeds the sidebar (worktrees, branches without one, remote-only, detached worktrees). `log::list` feeds the graph; the lane layout is computed in the frontend (`src/lib/graph.ts`). `history::commit_diff` and `commit_file_diff` feed the details pane (merge commits diff against the first parent).
- Worktree page: same sidebar and graph (scoped to the branch), `detail::load` for staging, `diff::file` for diffs, `operation` and `conflict` for paused rebases.
- Every screen has a hash route, so any screen opens in a new window.

## Core model

```
Repo       { root, common_git_dir, default_branch, bare }
Branch     { name, tip, upstream, ahead, behind, checked_out_in, last_commit }
Worktree   { path, kind: Main | Linked, head, branch, detached, locked, prunable }
Summary    { staged, unstaged, untracked, conflicts }
Operation  { kind: Rebase | Merge | CherryPick | Revert, applied, total, conflicted, resolved }
Overview   { repo, base, branches: [BranchRow { branch, worktree?, status?, ahead_of_base, stale }], detached, remote_only }
LogEntry   { id, parents, author, time, summary, refs, is_head }
```

## Worktree folders

New worktrees go next to the repo as `<repo>-<branch-slug>`. The New branch dialog shows the path and lets you change it. There is no config file; Pando adds nothing to a repo.

## Safety

- Backup ref under `refs/pando/backup/<branch>` for every branch a change moves (merge backs up both sides). Kept in the ref's reflog.
- Discard, forced Remove worktree and Drop stash first save what they throw away under `refs/pando/snapshots/<what>/<time>`. Nothing is ever pushed.
- `backup::list`, `restore_branch`, `restore_files` and `delete` back the sidebar's Backups section. Restoring backs up or snapshots what it replaces, so a restore can be undone too.
- Merge runs a preflight first: clean tree, ahead/behind, `merge-tree` conflict prediction, base worktree state. If it still hits conflicts, it undoes itself and points you to Sync with base.
- Sync with base, cherry-pick and revert pause on conflicts for the conflict screen. They never auto-abort.

## Targets

- Repo page for a 100k-file repo in under 1 s.
- Status update in under 200 ms.
