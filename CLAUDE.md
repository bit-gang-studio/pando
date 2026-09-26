# Pando: AI operating manual

Read `docs/architecture.md` first. The plan and status are the Crunchy board (project Pando, board General, via MCP). Never write a changelog or status here.

## Layout

- `crates/core` — `pando-core`. All git and worktree logic. Typed serde API.
- `crates/cli` — `pando` binary. Thin over core.
- `apps/desktop` — Tauri 2 shell + React 19 UI. Thin over core.

## Rules

- Desktop and CLI call `pando-core` only. No git calls outside core.
- Mutations shell out to the git CLI. Reads use gix. No libgit2.
- Every public core type is serde. No raw git output crosses the API.
- Write a backup ref under `refs/pando/backup/` before any mutation.
- Git floor is 2.39. Feature-detect newer flags.
- Keep docs minimal. Plain language. No filler.

## Commands

`just setup`, `just dev`, `just cli <args>`, `just test`, `just lint`, `just build`.

## Gotchas

- None yet. Add one only when a rule changes.
