//! Bring a worktree up to date with its base.

use crate::backup;
use crate::cmd::git;
use crate::error::Result;
use crate::repo::Repo;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncResult {
    pub ok: bool,
    /// Set when the rebase paused on conflicts. Resolve, then continue or abort.
    pub conflicts: Vec<String>,
    pub message: String,
}

/// Fetch, then rebase the worktree's branch onto `base`. On conflict the rebase
/// stays paused so the user can resolve it. A backup ref is written first.
pub fn rebase_onto(repo: &Repo, worktree: &Path, branch: &str, base: &str) -> Result<SyncResult> {
    backup::write(repo, branch)?;
    if base.contains('/') {
        let remote = base.split('/').next().unwrap_or("origin");
        let _ = git(worktree, ["fetch", "-q", remote]);
    }
    match git(worktree, ["rebase", base]) {
        Ok(_) => Ok(SyncResult {
            ok: true,
            conflicts: vec![],
            message: format!("Rebased {branch} onto {base}"),
        }),
        Err(e) => {
            let conflicts: Vec<String> = git(worktree, ["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect();
            if conflicts.is_empty() {
                let _ = git(worktree, ["rebase", "--abort"]);
                return Ok(SyncResult {
                    ok: false,
                    conflicts,
                    message: format!("Rebase failed and was undone. {e}"),
                });
            }
            let message = format!("Rebase paused on conflicts in {} file(s).", conflicts.len());
            Ok(SyncResult {
                ok: false,
                conflicts,
                message,
            })
        }
    }
}
