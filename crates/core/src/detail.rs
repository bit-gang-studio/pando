//! Everything the workspace detail screen shows, in one call.

use crate::branch::{self, Branch};
use crate::commit::CommitInfo;
use crate::error::Result;
use crate::history;
use crate::repo::{canon, Repo};
use crate::runtime;
use crate::status::{self, FileStatus};
use crate::workspace::{self, Workspace};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detail {
    pub repo: Repo,
    pub workspace: Workspace,
    pub branch: Option<Branch>,
    pub files: Vec<FileStatus>,
    /// Commits on this branch that are not on the base branch, newest first.
    pub ahead: Vec<CommitInfo>,
    pub base_branch: Option<String>,
    pub port: Option<u16>,
    pub head_summary: Option<String>,
}

pub fn load(repo: &Repo, path: &Path) -> Result<Detail> {
    let want = canon(path);
    let workspace = workspace::list(repo)?
        .into_iter()
        .find(|w| w.path == want)
        .ok_or_else(|| crate::Error::Config(format!("no workspace at {}", want.display())))?;
    let branch = match &workspace.branch {
        Some(b) => branch::list(repo)?.into_iter().find(|x| &x.name == b),
        None => None,
    };
    let files = status::files(&workspace.path)?;
    let (ahead, base_branch) = match &workspace.branch {
        Some(b) => {
            let h = history::linear(repo, b, 200)?;
            let n = h.base_index.unwrap_or(h.commits.len());
            (h.commits.into_iter().take(n).collect(), h.base_branch)
        }
        None => (Vec::new(), repo.default_branch.clone()),
    };
    let port = match &workspace.branch {
        Some(b) => runtime::port_for(repo, b)?,
        None => None,
    };
    let head_summary = branch
        .as_ref()
        .and_then(|b| b.last_commit.as_ref())
        .map(|c| c.summary.clone());
    Ok(Detail {
        repo: repo.clone(),
        workspace,
        branch,
        files,
        ahead,
        base_branch,
        port,
        head_summary,
    })
}
