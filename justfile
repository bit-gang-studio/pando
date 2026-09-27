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

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

# Build installers into apps/desktop/src-tauri/target/release/bundle
build:
    pnpm --filter @pando/desktop tauri build
