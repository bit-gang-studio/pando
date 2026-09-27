//! Everything the worktree detail screen shows, in one call.

use crate::branch::{self, Branch};
use crate::commit::CommitInfo;
use crate::error::Result;
use crate::history;
use crate::operation::{self, Operation};
use crate::repo::{canon, Repo};
use crate::status::{self, FileStatus};
use crate::worktree::{self, Worktree};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detail {
    pub repo: Repo,
    pub worktree: Worktree,
    pub branch: Option<Branch>,
    pub files: Vec<FileStatus>,
    /// Commits on this branch that are not on the base branch, newest first.
    pub ahead: Vec<CommitInfo>,
    pub base_branch: Option<String>,
    pub head_summary: Option<String>,
    pub operation: Option<Operation>,
}

pub fn load(repo: &Repo, path: &Path) -> Result<Detail> {
    let want = canon(path);
    let worktree = worktree::list(repo)?
        .into_iter()
        .find(|w| w.path == want)
        .ok_or_else(|| crate::Error::Msg(format!("no worktree at {}", want.display())))?;
    let branch = match &worktree.branch {
        Some(b) => branch::list(repo)?.into_iter().find(|x| &x.name == b),
        None => None,
    };
    let files = status::files(&worktree.path)?;
    // No `branch` means it has no commits yet (a new repo): nothing is ahead.
    let (ahead, base_branch) = match (&worktree.branch, &branch) {
        (Some(b), Some(_)) => {
            let h = history::linear(repo, b, 200)?;
            let n = h.base_index.unwrap_or(h.commits.len());
            (h.commits.into_iter().take(n).collect(), h.base_branch)
        }
        _ => (Vec::new(), repo.default_branch.clone()),
    };
    let operation = operation::detect(&worktree.path)?;
    let head_summary = branch
        .as_ref()
        .and_then(|b| b.last_commit.as_ref())
        .map(|c| c.summary.clone());
    Ok(Detail {
        repo: repo.clone(),
        worktree,
        branch,
        files,
        ahead,
        base_branch,
        head_summary,
        operation,
    })
}
