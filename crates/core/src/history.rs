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
    /// Full commit message.
    pub message: String,
    pub files: Vec<FileChange>,
}

pub fn commit_diff(repo: &Repo, id: &str) -> Result<CommitDiff> {
    let g = repo.open_gix()?;
    let info = commit::info(&g, commit::parse_id(id)?)?;
    // -m --first-parent: for merge commits, diff against the first parent
    // instead of git's combined format, which hides most files.
    let stat = git(
        &repo.common_git_dir,
        [
            "show",
            "-m",
            "--first-parent",
            "--format=",
            "--numstat",
            "--no-renames",
            id,
        ],
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
    let message = git(&repo.common_git_dir, ["log", "-1", "--format=%B", id])?
        .trim_end()
        .to_string();
    Ok(CommitDiff {
        commit: info,
        message,
        files,
    })
}

/// Structured diff of one file in one commit.
pub fn commit_file_diff(repo: &Repo, id: &str, path: &str) -> Result<crate::diff::FileDiff> {
    let out = git(
        &repo.common_git_dir,
        [
            "show",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            id,
            "--",
            path,
        ],
    )?;
    let mut d = crate::diff::parse_unified(&out);
    d.path = path.to_string();
    Ok(d)
}
