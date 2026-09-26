//! Pando core. All git and worktree logic lives here.
//! Every public type is serde so the CLI, the desktop app, and any
//! future daemon speak the same contract.

pub mod backup;
pub mod board;
pub mod branch;
mod cmd;
pub mod config;
pub mod error;
pub mod git;
pub mod hooks;
pub mod launch;
pub mod repo;
pub mod runtime;
pub mod status;
pub mod user_config;
pub mod workspace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use board::{Board, Row};
pub use branch::Branch;
pub use config::RepoConfig;
pub use error::{Error, Result};
pub use git::{doctor, Doctor};
pub use hooks::HookResult;
pub use repo::Repo;
pub use status::Summary;
pub use user_config::UserConfig;
pub use workspace::{AddWorkspace, CreateWorkspace, Created, Workspace, WorkspaceKind};
