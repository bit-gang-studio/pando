//! Linear history and single-commit diffs.

use crate::cmd::git;
use crate::commit::{self, CommitInfo};
use crate::error::{gix_err, Result};
use crate::repo::Repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub commits: Vec<CommitInfo>,
    /// Index in `commits` of the merge base with the default branch, if it is in range.
    pub base_index: Option<usize>,
    pub base_branch: Option<String>,
}

/// First-parent history of `rev`, newest first.
pub fn linear(repo: &Repo, rev: &str, limit: usize) -> Result<History> {
    let g = repo.open_gix()?;
    let tip = g.rev_parse_single(rev).map_err(gix_err)?.detach();
    let base_branch = repo.default_branch.clone();
    let base_id = base_branch
        .as_deref()
        .and_then(|b| g.rev_parse_single(b).ok())
        .and_then(|b| g.merge_base(tip, b.detach()).ok())
        .map(|id| id.detach());

    let mut commits = Vec::new();
    let mut base_index = None;
    let walk = g
        .rev_walk([tip])
        .first_parent_only()
        .all()
        .map_err(gix_err)?;
    for c in walk.take(limit) {
        let c = c.map_err(gix_err)?;
        if Some(c.id) == base_id {
            base_index = Some(commits.len());
        }
        commits.push(commit::info(&g, c.id)?);
    }
    Ok(History {
        commits,
        base_index,
        base_branch,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitDiff {
    pub commit: CommitInfo,
    pub files: Vec<FileChange>,
    /// Unified diff text.
    pub patch: String,
}

pub fn commit_diff(repo: &Repo, id: &str) -> Result<CommitDiff> {
    let g = repo.open_gix()?;
    let info = commit::info(&g, commit::parse_id(id)?)?;
    let stat = git(
        &repo.common_git_dir,
        ["show", "--format=", "--numstat", "--no-renames", id],
    )?;
    let files = stat
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            let added = p.next()?.parse().unwrap_or(0);
            let deleted = p.next()?.parse().unwrap_or(0);
            Some(FileChange {
                path: p.next()?.to_string(),
                added,
                deleted,
            })
        })
        .collect();
    let patch = git(&repo.common_git_dir, ["show", "--format=", "--patch", id])?;
    Ok(CommitDiff {
        commit: info,
        files,
        patch,
    })
}
