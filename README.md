# Pando

The worktree-native Git client. Open source, cross-platform.

**Status:** pre-alpha. Nothing to install yet.

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
pando ls                 # workspaces
pando branches
pando new feat/x         # worktree + .pando.toml hooks + port
pando rm feat/x
cd "$(pando switch feat/x)"
pando open feat/x        # $PANDO_EDITOR, $VISUAL, or $EDITOR
eval "$(pando shell-init zsh)"   # adds `pcd feat/x`
```

Per-repo setup lives in `.pando.toml`. See this repo's for an example.

## License

Apache-2.0. Sign commits with `git commit -s` (DCO).
