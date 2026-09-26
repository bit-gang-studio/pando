//! Pando core. All git and worktree logic lives here.
//! Every public type is serde so the CLI, the desktop app, and any
//! future daemon speak the same contract.

pub mod backup;
pub mod board;
pub mod branch;
mod cmd;
pub mod commit;
pub mod config;
pub mod error;
pub mod git;
pub mod history;
pub mod hooks;
pub mod launch;
pub mod repo;
pub mod runtime;
pub mod stash;
pub mod status;
pub mod tag;
pub mod user_config;
pub mod workspace;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use board::{Board, Row};
pub use branch::{Branch, RemoteBranch};
pub use commit::CommitInfo;
pub use config::RepoConfig;
pub use error::{Error, Result};
pub use git::{doctor, Doctor};
pub use history::{CommitDiff, History};
pub use hooks::HookResult;
pub use repo::Repo;
pub use stash::Stash;
pub use status::Summary;
pub use tag::Tag;
pub use user_config::UserConfig;
pub use workspace::{AddWorkspace, CreateWorkspace, Created, Workspace, WorkspaceKind};
