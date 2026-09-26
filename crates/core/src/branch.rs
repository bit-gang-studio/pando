//! Branches. Reads go through gix; ahead/behind is a rev walk against the
//! upstream. Mutations shell out to git.

use crate::backup;
use crate::cmd::git;
use crate::commit::{self, CommitInfo};
use crate::error::{gix_err, Result};
use crate::repo::Repo;
use crate::worktree;
use gix::remote::Direction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Branch {
    pub name: String,
    pub tip: String,
    /// Short upstream name like `origin/main`.
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// Worktree that has this branch checked out, if any.
    pub checked_out_in: Option<PathBuf>,
    pub last_commit: Option<CommitInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteBranch {
    /// e.g. `origin/feat/x`
    pub name: String,
    pub remote: String,
    /// Branch name without the remote prefix.
    pub short: String,
    pub tip: String,
    /// A local branch tracks it.
    pub tracked: bool,
    pub last_commit: Option<CommitInfo>,
}

pub fn list(repo: &Repo) -> Result<Vec<Branch>> {
    let checked_out: HashMap<String, PathBuf> = worktree::list(repo)?
        .into_iter()
        .filter_map(|w| w.branch.map(|b| (b, w.path)))
        .collect();

    let g = repo.open_gix()?;
    let refs = g.references().map_err(gix_err)?;
    let mut out = Vec::new();
    for r in refs.local_branches().map_err(gix_err)? {
        let r = r.map_err(gix_err)?;
        let full = r.name().to_owned();
        let name = full.shorten().to_string();
        let tip = match r.into_fully_peeled_id() {
            Ok(id) => id.detach(),
            Err(_) => continue, // unborn or broken ref
        };

        let mut b = Branch {
            name: name.clone(),
            tip: tip.to_string(),
            upstream: None,
            ahead: None,
            behind: None,
            checked_out_in: checked_out.get(&name).cloned(),
            last_commit: commit::info(&g, tip).ok(),
        };

        if let Some(Ok(track)) = g.branch_remote_tracking_ref_name(full.as_ref(), Direction::Fetch)
        {
            let track_name = track.as_bstr().to_string();
            b.upstream = Some(
                track_name
                    .strip_prefix("refs/remotes/")
                    .unwrap_or(&track_name)
                    .to_string(),
            );
            if let Ok(up) = g.find_reference(track.as_ref()) {
                if let Ok(up_id) = up.into_fully_peeled_id() {
                    let up_id = up_id.detach();
                    b.ahead = Some(count_only_in(&g, tip, up_id)?);
                    b.behind = Some(count_only_in(&g, up_id, tip)?);
                }
            }
        }
        out.push(b);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn list_remote(repo: &Repo) -> Result<Vec<RemoteBranch>> {
    let tracked: std::collections::HashSet<String> =
        list(repo)?.into_iter().filter_map(|b| b.upstream).collect();
    let g = repo.open_gix()?;
    let refs = g.references().map_err(gix_err)?;
    let mut out = Vec::new();
    for r in refs.remote_branches().map_err(gix_err)? {
        let r = r.map_err(gix_err)?;
        let name = r.name().shorten().to_string();
        if name.ends_with("/HEAD") {
            continue;
        }
        let Ok(tip) = r.into_fully_peeled_id() else {
            continue;
        };
        let tip = tip.detach();
        let (remote, short) = name.split_once('/').unwrap_or(("", &name));
        out.push(RemoteBranch {
            remote: remote.to_string(),
            short: short.to_string(),
            tracked: tracked.contains(&name),
            tip: tip.to_string(),
            last_commit: commit::info(&g, tip).ok(),
            name: name.clone(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Commits reachable from `from` but not from `hide`.
pub(crate) fn count_only_in(
    g: &gix::Repository,
    from: gix::ObjectId,
    hide: gix::ObjectId,
) -> Result<u32> {
    let walk = g
        .rev_walk([from])
        .with_hidden([hide])
        .all()
        .map_err(gix_err)?;
    let mut n = 0u32;
    for c in walk {
        c.map_err(gix_err)?;
        n += 1;
    }
    Ok(n)
}

// ---- mutations -----------------------------------------------------------

/// Check out `name` in the main worktree. Fails if the tree is dirty and git refuses.
pub fn switch_in_main(repo: &Repo, name: &str) -> Result<()> {
    git(&repo.root, ["switch", name])?;
    Ok(())
}

/// Create a local branch from `base` (default HEAD) without checking it out.
pub fn create(repo: &Repo, name: &str, base: Option<&str>) -> Result<()> {
    let mut args = vec!["branch", name];
    if let Some(b) = base {
        args.push(b);
    }
    git(&repo.root, &args)?;
    Ok(())
}

/// Create a local branch that tracks `remote_branch` (e.g. `origin/feat/x`).
pub fn track_remote(repo: &Repo, remote_branch: &str, local: &str) -> Result<()> {
    git(&repo.root, ["branch", "--track", local, remote_branch])?;
    Ok(())
}

pub fn rename(repo: &Repo, old: &str, new: &str) -> Result<()> {
    backup::write(repo, old)?;
    git(&repo.root, ["branch", "-m", old, new])?;
    Ok(())
}

/// Delete a local branch. Writes a backup ref first so it can be restored.
pub fn delete(repo: &Repo, name: &str, force: bool) -> Result<()> {
    backup::write(repo, name)?;
    git(
        &repo.root,
        ["branch", if force { "-D" } else { "-d" }, name],
    )?;
    Ok(())
}

pub fn delete_remote(repo: &Repo, remote: &str, name: &str) -> Result<()> {
    git(&repo.root, ["push", remote, "--delete", name])?;
    Ok(())
}

pub fn set_upstream(repo: &Repo, name: &str, upstream: &str) -> Result<()> {
    git(&repo.root, ["branch", "--set-upstream-to", upstream, name])?;
    Ok(())
}

pub fn fetch_all(repo: &Repo) -> Result<()> {
    git(&repo.root, ["fetch", "--all", "--prune"])?;
    Ok(())
}

/// Push `name` to `remote`, setting upstream if it has none.
pub fn push(repo: &Repo, name: &str, remote: &str, force_with_lease: bool) -> Result<()> {
    let mut args = vec!["push", "-u"];
    if force_with_lease {
        args.push("--force-with-lease");
    }
    args.extend([remote, name]);
    git(&repo.root, &args)?;
    Ok(())
}

/// Pull into the worktree that has the branch checked out.
pub fn pull(worktree: &Path, rebase: bool) -> Result<()> {
    let mut args = vec!["pull"];
    args.push(if rebase { "--rebase" } else { "--no-rebase" });
    git(worktree, &args)?;
    Ok(())
}
