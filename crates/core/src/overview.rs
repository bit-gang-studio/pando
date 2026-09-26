//! One call for the main screen: every branch, with its worktree if it has one.

use crate::branch::{self, Branch, RemoteBranch};
use crate::error::Result;
use crate::merge;
use crate::repo::Repo;
use crate::status::{self, Summary};
use crate::worktree::{self, Worktree, WorktreeKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const STALE_DAYS: i64 = 14;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchRow {
    pub branch: Branch,
    /// Set when the branch has a worktree.
    pub worktree: Option<Worktree>,
    pub is_main_worktree: bool,
    pub status: Option<Summary>,
    /// Commits not on the base branch.
    pub ahead_of_base: Option<u32>,
    /// Has a worktree, is clean, and its last commit is older than `STALE_DAYS`.
    pub stale: bool,
}

/// A worktree with no branch checked out (detached HEAD). Common for submodules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetachedRow {
    pub worktree: Worktree,
    pub is_main_worktree: bool,
    pub status: Option<Summary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Overview {
    pub repo: Repo,
    pub base: Option<String>,
    /// Local branches, worktree ones first, then by name.
    pub branches: Vec<BranchRow>,
    /// Worktrees on a detached HEAD.
    pub detached: Vec<DetachedRow>,
    /// Remote branches with no local branch.
    pub remote_only: Vec<RemoteBranch>,
}

pub fn load(repo: &Repo) -> Result<Overview> {
    let base = merge::default_base(repo).ok();
    let g = repo.open_gix()?;
    let base_id = base
        .as_deref()
        .and_then(|b| g.rev_parse_single(b).ok())
        .map(|id| id.detach());
    let all_worktrees = worktree::list(repo)?;
    let detached = all_worktrees
        .iter()
        .filter(|w| w.branch.is_none() && !w.bare)
        .map(|w| DetachedRow {
            is_main_worktree: w.kind == WorktreeKind::Main,
            status: if w.prunable.is_none() && w.path.is_dir() {
                status::summary(&w.path).ok()
            } else {
                None
            },
            worktree: w.clone(),
        })
        .collect();
    let worktrees: BTreeMap<String, Worktree> = all_worktrees
        .into_iter()
        .filter_map(|w| w.branch.clone().map(|b| (b, w)))
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut rows = Vec::new();
    for b in branch::list(repo)? {
        let wt = worktrees.get(&b.name).cloned();
        let st = wt
            .as_ref()
            .filter(|w| w.prunable.is_none() && w.path.is_dir())
            .and_then(|w| status::summary(&w.path).ok());
        let ahead_of_base = match base_id {
            Some(bid) => {
                let tip = gix::ObjectId::from_hex(b.tip.as_bytes()).ok();
                tip.map(|t| branch::count_only_in(&g, t, bid)).transpose()?
            }
            None => None,
        };
        let idle_days = b
            .last_commit
            .as_ref()
            .map(|c| (now - c.time) / 86400)
            .unwrap_or(0);
        let is_main = wt
            .as_ref()
            .map(|w| w.kind == WorktreeKind::Main)
            .unwrap_or(false);
        let stale = wt.is_some()
            && !is_main
            && st.map(|s| s.is_clean()).unwrap_or(false)
            && idle_days >= STALE_DAYS;
        rows.push(BranchRow {
            is_main_worktree: is_main,
            worktree: wt,
            status: st,
            ahead_of_base,
            stale,
            branch: b,
        });
    }
    rows.sort_by(|a, b| {
        let rank = |r: &BranchRow| (r.worktree.is_none(), !r.is_main_worktree);
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.branch.name.cmp(&b.branch.name))
    });

    let remote_only = branch::list_remote(repo)?
        .into_iter()
        .filter(|r| !r.tracked)
        .collect();

    Ok(Overview {
        repo: repo.clone(),
        base,
        branches: rows,
        detached,
        remote_only,
    })
}
