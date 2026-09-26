//! Pando core. All git and worktree logic lives here.
//! Every public type is serde so the CLI, the desktop app, and any
//! future daemon speak the same contract.

pub mod backup;
pub mod branch;
mod cmd;
pub mod config;
pub mod error;
pub mod git;
pub mod hooks;
pub mod launch;
pub mod repo;
pub mod runtime;
pub mod workspace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use branch::Branch;
pub use config::RepoConfig;
pub use error::{Error, Result};
pub use git::{doctor, Doctor};
pub use hooks::HookResult;
pub use repo::Repo;
pub use workspace::{AddWorkspace, CreateWorkspace, Created, Workspace, WorkspaceKind};
