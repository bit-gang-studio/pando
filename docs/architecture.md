# Architecture

## Two nouns

- **Branch**: a git branch. Checked out in the main worktree, in a worktree, or nowhere.
- **Worktree**: a git worktree plus what is attached to it: branch, base, status, PR, ports, processes, overlaps.

## Layers

```
apps/desktop (Tauri 2 + React)     crates/cli (pando)
             \                        /
              crates/core (pando-core)
```

Core is the only place that touches git. Its API is plain serde request and response types. In v1 both apps link core in-process. A daemon or hosted version can wrap the same API later.

## Git backend

- Mutations: the user's `git` CLI, porcelain and `-z` output. Hooks, credentials, signing, and fsmonitor keep working.
- Reads: gix (gitoxide) in-process.
- Status: `git status --porcelain=v2 -z`.
- No libgit2. Floor is git 2.39.

## Screens and core calls

- Repositories: `user_config` repo list, plus `overview::load` per repo for counts.
- Repo page: `overview::load` feeds the sidebar (worktrees, branches without one, remote-only, detached worktrees). `log::list` feeds the graph; the lane layout is computed in the frontend (`src/lib/graph.ts`). `history::commit_diff` and `commit_file_diff` feed the details pane (merge commits diff against the first parent).
- Worktree page: same sidebar and graph (scoped to the branch), `detail::load` for staging, `diff::file` for diffs, `operation` and `conflict` for paused rebases.
- Every screen has a hash route, so any screen opens in a new window.

## Core model

```
Repo       { root, common_git_dir, default_branch, forge, config }
Branch     { name, upstream, ahead, behind, tip, checked_out_in, pr }
Worktree  { path, branch, base, kind: Main | Linked, locked }
Status     { staged, unstaged, untracked, ahead, behind, conflicts }
Overlap    { a, b, files: [{ path, hunks }] }
Operation  { kind: Rebase | Merge | CherryPick, applied, total, conflicted, resolved }
Overview   { repo, base, branches: [BranchRow { branch, worktree?, status?, ahead_of_base, stale }], detached, remote_only }
LogEntry   { id, parents, author, time, summary, refs, is_head }
```

## Worktree folders

New worktrees go next to the repo as `<repo>-<branch-slug>`. The New branch dialog shows the path and lets you change it. There is no config file; Pando adds nothing to a repo.

## Safety

- Backup ref under `refs/pando/backup/<branch>` before every mutation.
- Every action is logged so Recent actions can undo it.
- Merge always runs a preflight first: clean tree, ahead/behind, `merge-tree` conflict prediction, base worktree state.
- Merge and Sync leave a conflicted rebase paused for the conflict screen; they never auto-abort.

## Targets

- Board for a 100k-file repo in under 1 s.
- Status update in under 200 ms.
