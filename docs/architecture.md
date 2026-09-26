# Architecture

## Two nouns

- **Branch**: a git branch. Checked out in the main worktree, in a workspace, or nowhere.
- **Workspace**: a worktree plus what is attached to it: branch, base, status, PR, ports, processes, overlaps.

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

## Core model

```
Repo       { root, common_git_dir, default_branch, forge, config }
Branch     { name, upstream, ahead, behind, tip, checked_out_in, pr }
Workspace  { path, branch, base, kind: Main | Linked, locked }
Status     { staged, unstaged, untracked, ahead, behind, conflicts }
Runtime    { ports, env, processes, agent }
Overlap    { a, b, files: [{ path, hunks }] }
Operation  { kind: Rebase | Merge | CherryPick, applied, remaining, conflicted, backup_ref }
```

## Config

`.pando.toml` at the repo root, committed. Sections: `workspace` (location, base), `hooks` (post_create, pre_land, post_land), `runtime` (port, share), `land` (strategy, delete_branch, remove_worktree), `agents.<name>`.

User prefs in `~/.config/pando/config.toml`.

## Safety

- Backup ref under `refs/pando/backup/<branch>` before every mutation.
- Every action is logged so Recent actions can undo it.
- Land and Clean always run a preflight first.

## Targets

- Board for a 100k-file repo in under 1 s.
- Status update in under 200 ms.
- Overlap check for 30 workspaces in under 500 ms.
