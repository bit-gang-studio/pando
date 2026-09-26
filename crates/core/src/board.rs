//! Everything the board screen shows for one repo, in one call.

use crate::branch::{self, Branch};
use crate::error::{gix_err, Result};
use crate::repo::Repo;
use crate::runtime;
use crate::status::{self, Summary};
use crate::worktree::{self, Worktree};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub worktree: Worktree,
    pub branch: Option<Branch>,
    pub port: Option<u16>,
    /// `None` when the worktree directory is missing.
    pub status: Option<Summary>,
    /// Unix seconds of the HEAD commit.
    pub last_commit_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    pub repo: Repo,
    pub rows: Vec<Row>,
    pub ports: BTreeMap<String, u16>,
}

pub fn load(repo: &Repo) -> Result<Board> {
    let branches: BTreeMap<String, Branch> = branch::list(repo)?
        .into_iter()
        .map(|b| (b.name.clone(), b))
        .collect();
    let ports = runtime::ports(repo)?;
    let g = repo.open_gix()?;

    let mut rows = Vec::new();
    for ws in worktree::list(repo)? {
        let st = if ws.prunable.is_none() && ws.path.is_dir() {
            status::summary(&ws.path).ok()
        } else {
            None
        };
        let last_commit_at = ws.head.as_deref().and_then(|h| commit_time(&g, h).ok());
        let branch = ws.branch.as_ref().and_then(|b| branches.get(b).cloned());
        let port = ws.branch.as_ref().and_then(|b| ports.get(b).copied());
        rows.push(Row {
            worktree: ws,
            branch,
            port,
            status: st,
            last_commit_at,
        });
    }
    Ok(Board {
        repo: repo.clone(),
        rows,
        ports,
    })
}

fn commit_time(g: &gix::Repository, hex: &str) -> Result<i64> {
    let id = gix::ObjectId::from_hex(hex.as_bytes()).map_err(gix_err)?;
    let commit = g.find_commit(id).map_err(gix_err)?;
    Ok(commit.time().map_err(gix_err)?.seconds)
}
