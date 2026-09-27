use crate::error::{gix_err, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    /// Unix seconds.
    pub time: i64,
}

pub(crate) fn info(g: &gix::Repository, id: gix::ObjectId) -> Result<CommitInfo> {
    let c = g.find_commit(id).map_err(gix_err)?;
    let summary = c
        .message()
        .map(|m| m.summary().to_string())
        .unwrap_or_default();
    let author = c.author().map(|a| a.name.to_string()).unwrap_or_default();
    let time = c.time().map_err(gix_err)?.seconds;
    Ok(CommitInfo {
        id: id.to_string(),
        summary,
        author,
        time,
    })
}

/// Commit the index. Returns the new commit id.
pub fn create(worktree: &std::path::Path, message: &str, amend: bool) -> Result<String> {
    let mut args = vec!["commit", "-q", "-m", message];
    if amend {
        args.push("--amend");
    }
    crate::cmd::git(worktree, &args)?;
    Ok(crate::cmd::git(worktree, ["rev-parse", "HEAD"])?
        .trim()
        .to_string())
}

/// Outcome of an operation that can stop on conflicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Applied {
    Done,
    /// Stopped on conflicts. Resolve in the worktree, then continue or abort.
    Paused,
}

fn current_branch(worktree: &std::path::Path) -> Option<String> {
    crate::cmd::git(worktree, ["branch", "--show-current"])
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
}

fn backup_current(repo: &crate::repo::Repo, worktree: &std::path::Path) -> Result<()> {
    if let Some(b) = current_branch(worktree) {
        crate::backup::write(repo, &b)?;
    }
    Ok(())
}

fn stopped_on_conflicts(worktree: &std::path::Path) -> bool {
    crate::cmd::git(worktree, ["diff", "--name-only", "--diff-filter=U"])
        .map(|o| !o.trim().is_empty())
        .unwrap_or(false)
}

/// `git cherry-pick <id>` in `worktree`. A backup ref is written first.
pub fn cherry_pick(
    repo: &crate::repo::Repo,
    worktree: &std::path::Path,
    id: &str,
) -> Result<Applied> {
    backup_current(repo, worktree)?;
    match crate::cmd::git(worktree, ["cherry-pick", id]) {
        Ok(_) => Ok(Applied::Done),
        Err(_) if stopped_on_conflicts(worktree) => Ok(Applied::Paused),
        Err(e) => {
            let _ = crate::cmd::git(worktree, ["cherry-pick", "--abort"]);
            Err(e)
        }
    }
}

/// `git revert --no-edit <id>` in `worktree`. A backup ref is written first.
pub fn revert(repo: &crate::repo::Repo, worktree: &std::path::Path, id: &str) -> Result<Applied> {
    backup_current(repo, worktree)?;
    match crate::cmd::git(worktree, ["revert", "--no-edit", id]) {
        Ok(_) => Ok(Applied::Done),
        Err(_) if stopped_on_conflicts(worktree) => Ok(Applied::Paused),
        Err(e) => {
            let _ = crate::cmd::git(worktree, ["revert", "--abort"]);
            Err(e)
        }
    }
}
