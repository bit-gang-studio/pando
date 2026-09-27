# Pando

A simple, honest Git GUI where worktrees are first class. Open source, cross-platform.

**Status:** pre-alpha. Unsigned builds on [Releases](https://github.com/bit-gang-studio/pando/releases). CLI: `brew install bit-gang-studio/tap/pando`.

## Develop

Needs Rust (rustup), Node 22, pnpm, and `just`.

```sh
just setup
just dev          # desktop app
just cli doctor   # CLI
just test
```

## CLI

```sh
pando list               # branches and their worktrees
pando add feat/x         # git worktree add, in a sibling folder <repo>-feat-x
pando add feat/x --existing
pando remove feat/x      # git worktree remove; the branch stays
cd "$(pando switch feat/x)"
eval "$(pando shell-init zsh)"   # adds `pcd feat/x`
```

## License

Apache-2.0. Sign commits with `git commit -s` (DCO).
