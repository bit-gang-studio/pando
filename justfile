default:
    @just --list

# Install JS deps
setup:
    pnpm install

# Run the desktop app with hot reload
dev:
    pnpm --filter @pando/desktop tauri dev

# Run the CLI, e.g. `just cli doctor`
cli *args:
    cargo run -p pando-cli -- {{args}}

# Core, CLI and screen tests
test:
    cargo test --workspace
    pnpm --filter @pando/desktop exec tsc --noEmit
    pnpm --filter @pando/desktop exec playwright test

# Real git in the browser: throwaway repo, real commands via the dev bridge. Slower; run before releases.
test-real:
    pnpm --filter @pando/desktop exec playwright test -c e2e-real

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

# Build installers into target/release/bundle. Signs update files if ~/.tauri has the key.
build:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f ~/.tauri/pando-updater.key ]; then
      export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pando-updater.key)"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/pando-updater.password)"
      pnpm --filter @pando/desktop tauri build
    else
      pnpm --filter @pando/desktop tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
    fi
