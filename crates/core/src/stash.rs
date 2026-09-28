//! Stashes. They belong to the repo, not a worktree.

use crate::cmd::{git, git_bytes};
use crate::error::Result;
use crate::repo::Repo;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stash {
    pub index: u32,
    /// e.g. `On main: tweak ci`
    pub message: String,
    pub branch: Option<String>,
    pub time: i64,
}

pub fn list(repo: &Repo) -> Result<Vec<Stash>> {
    let out = git_bytes(
        &repo.root,
        ["stash", "list", "-z", "--format=%gd%x1f%gs%x1f%ct"],
    )?;
    let text = String::from_utf8_lossy(&out);
    Ok(text
        .split('\0')
        .filter(|e| !e.is_empty())
        .filter_map(|e| {
            let mut f = e.split('\x1f');
            let sel = f.next()?; // stash@{0}
            let index = sel
                .trim_start_matches("stash@{")
                .trim_end_matches('}')
                .parse()
                .ok()?;
            let message = f.next()?.to_string();
            let time = f.next()?.trim().parse().unwrap_or(0);
            let branch = message
                .strip_prefix("On ")
                .or_else(|| message.strip_prefix("WIP on "))
                .and_then(|r| r.split(':').next())
                .map(str::to_string);
            Some(Stash {
                index,
                message,
                branch,
                time,
            })
        })
        .collect())
}

/// Stash the working tree of `worktree`. Returns `false` if there was nothing to stash.
pub fn save(worktree: &Path, message: Option<&str>) -> Result<bool> {
    let mut args = vec!["stash", "push", "--include-untracked"];
    if let Some(m) = message {
        args.extend(["-m", m]);
    }
    let out = git(worktree, &args)?;
    Ok(!out.contains("No local changes"))
}

pub fn apply(worktree: &Path, index: u32) -> Result<()> {
    git(worktree, ["stash", "apply", &format!("stash@{{{index}}}")])?;
    Ok(())
}

pub fn pop(worktree: &Path, index: u32) -> Result<()> {
    git(worktree, ["stash", "pop", &format!("stash@{{{index}}}")])?;
    Ok(())
}

/// Drop a stash. It stays reachable under `refs/pando/snapshots/stash/`.
/// Returns the snapshot ref that keeps the stash, for Undo.
pub fn drop(repo: &Repo, index: u32) -> Result<String> {
    let id = git(&repo.root, ["rev-parse", &format!("stash@{{{index}}}")])?;
    let kept = crate::backup::keep_commit(repo, "stash", id.trim())?;
    git(&repo.root, ["stash", "drop", &format!("stash@{{{index}}}")])?;
    Ok(kept)
}

/// Undo Drop: put a dropped stash back in the stash list (`git stash store`).
pub fn restore(repo: &Repo, kept: &str, message: &str) -> Result<()> {
    if !kept.starts_with(crate::backup::SNAPSHOTS) {
        return Err(crate::Error::Msg(format!("{kept} isn't a Pando backup")));
    }
    let id = git(&repo.common_git_dir, ["rev-parse", kept])?;
    git(&repo.root, ["stash", "store", "-m", message, id.trim()])?;
    Ok(())
}
