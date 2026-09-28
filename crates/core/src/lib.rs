//! Pando core. All git and worktree logic lives here.
//! Every public type is serde so the CLI, the desktop app, and any
//! future daemon speak the same contract.

pub mod access;
pub mod backup;
pub mod branch;
mod cmd;
pub mod commit;
pub mod conflict;
pub mod detail;
pub mod diff;
pub mod error;
pub mod git;
pub mod github;
pub mod history;
pub mod index;
pub mod log;
pub mod merge;
pub mod operation;
pub mod overview;
pub mod repo;
pub mod stash;
pub mod status;
pub mod sync;
pub mod tag;
pub mod user_config;
pub mod watch;
pub mod worktree;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use backup::Backup;
pub use branch::{Branch, RemoteBranch};
pub use commit::{Applied, CommitInfo};
pub use conflict::{ConflictFile, Side};
pub use detail::Detail;
pub use diff::{FileDiff, Hunk, Line, LineKind};
pub use error::{Error, Result};
pub use git::{doctor, Doctor};
pub use history::{CommitDiff, History};
pub use log::{Log, LogEntry};
pub use merge::{MergePlan, MergeResult, Preflight, Strategy};
pub use operation::{OpKind, Operation};
pub use overview::{BranchRow, DetachedRow, Overview};
pub use repo::Repo;
pub use stash::Stash;
pub use status::{FileStatus, Summary};
pub use sync::SyncResult;
pub use tag::Tag;
pub use user_config::UserConfig;
pub use worktree::{AddWorktree, CreateWorktree, Created, Worktree, WorktreeKind};
