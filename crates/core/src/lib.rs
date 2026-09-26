//! Pando core. All git and worktree logic lives here.
//! Every public type is serde so the CLI, the desktop app, and any
//! future daemon speak the same contract.

pub mod git;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use git::{doctor, Doctor};
