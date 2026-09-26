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

## One screen

`overview::load(repo)` returns every local branch with its worktree (if any), status, port, and commits ahead of the base, plus remote-only branches. The desktop's home screen is that list. Clicking a row opens `detail::load` for that worktree.

## Core model

```
Repo       { root, common_git_dir, default_branch, forge, config }
Branch     { name, upstream, ahead, behind, tip, checked_out_in, pr }
Worktree  { path, branch, base, kind: Main | Linked, locked }
Status     { staged, unstaged, untracked, ahead, behind, conflicts }
Overlap    { a, b, files: [{ path, hunks }] }
Operation  { kind: Rebase | Merge | CherryPick, applied, total, conflicted, resolved }
Overview   { repo, base, branches: [BranchRow { branch, worktree?, status?, port?, ahead_of_base, stale }], remote_only }
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
