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
    /// Ahead and behind, and everything the upstream has that this branch
    /// doesn't was on this branch before: it was rewritten here (reword,
    /// squash, drop, amend, rebase). Force push is the way forward, not pull.
    pub upstream_rewritten: bool,
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
    let counts = upstream_counts(repo);
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
            upstream_rewritten: false,
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
            if g.find_reference(track.as_ref()).is_ok() {
                if let Some((ahead, behind)) = counts.get(&name) {
                    b.ahead = Some(*ahead);
                    b.behind = Some(*behind);
                    b.upstream_rewritten =
                        *ahead > 0 && *behind > 0 && had_before(repo, &name, &track_name);
                }
            }
        }
        out.push(b);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn list_remote(repo: &Repo) -> Result<Vec<RemoteBranch>> {
    // Which remote branches some local branch tracks. Asked of git directly:
    // building the whole local list again just for this doubled the work.
    let tracked: std::collections::HashSet<String> = git(
        &repo.common_git_dir,
        ["for-each-ref", "--format=%(upstream:short)", "refs/heads"],
    )?
    .lines()
    .filter(|l| !l.is_empty())
    .map(str::to_string)
    .collect();
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

/// How many commits each local branch has that `base` doesn't, by branch name.
///
/// One git call finds the branches with anything ahead; most branches in a
/// big repo have nothing. Only those few are counted, a handful at a time.
/// Walking every branch's history ourselves took 34 seconds on a repo with
/// 80,000 commits and 300 branches.
pub(crate) fn ahead_of(repo: &Repo, base: &str, branches: &[Branch]) -> HashMap<String, u32> {
    let dir = &repo.common_git_dir;
    let listed = crate::cmd::git_raw(
        dir,
        [
            "for-each-ref",
            "--format=%(refname)",
            &format!("--no-merged={base}"),
            "refs/heads",
        ],
    );
    // If that failed, count every branch rather than guess.
    let ahead: Option<std::collections::HashSet<&str>> = match &listed {
        Ok((0, out, _)) => Some(
            out.lines()
                .filter_map(|l| l.strip_prefix("refs/heads/"))
                .collect(),
        ),
        _ => None,
    };
    let to_count: Vec<&Branch> = branches
        .iter()
        .filter(|b| ahead.as_ref().is_none_or(|a| a.contains(b.name.as_str())))
        .collect();
    let mut out: HashMap<String, u32> = branches.iter().map(|b| (b.name.clone(), 0)).collect();
    for chunk in to_count.chunks(8) {
        let counted: Vec<(String, Option<u32>)> = std::thread::scope(|s| {
            let jobs: Vec<_> = chunk
                .iter()
                .map(|b| {
                    let range = format!("{base}..{}", b.tip);
                    (
                        b.name.clone(),
                        s.spawn(move || {
                            crate::cmd::git_opt(dir, ["rev-list", "--count", &range, "--"])
                                .and_then(|n| n.parse().ok())
                        }),
                    )
                })
                .collect();
            jobs.into_iter()
                .map(|(n, j)| (n, j.join().ok().flatten()))
                .collect()
        });
        for (name, n) in counted {
            match n {
                Some(n) => out.insert(name, n),
                None => out.remove(&name),
            };
        }
    }
    out
}

/// Commits reachable from `from` but not from `hide`. Git does the walk:
/// it stops as soon as the two histories meet, where walking it ourselves
/// read the whole history each time.
pub(crate) fn count_only_in(repo: &Repo, from: &str, hide: &str) -> Result<u32> {
    let out = git(
        &repo.common_git_dir,
        ["rev-list", "--count", &format!("{hide}..{from}"), "--"],
    )?;
    Ok(out.trim().parse().unwrap_or(0))
}

/// Ahead and behind of its upstream, for every local branch that has one, by
/// branch name. One git call for all of them.
fn upstream_counts(repo: &Repo) -> HashMap<String, (u32, u32)> {
    let Some(out) = crate::cmd::git_opt(
        &repo.common_git_dir,
        [
            "for-each-ref",
            "--format=%(refname)%00%(upstream:track,nobracket)",
            "refs/heads",
        ],
    ) else {
        return HashMap::new();
    };
    out.lines()
        .filter_map(|l| {
            let (name, track) = l.split_once('\0')?;
            let name = name.strip_prefix("refs/heads/")?;
            // "", "ahead 2", "behind 3", "ahead 2, behind 3" or "gone".
            if track == "gone" {
                return None;
            }
            let n = |word: &str| {
                track
                    .split(", ")
                    .find_map(|p| p.strip_prefix(word)?.trim().parse().ok())
                    .unwrap_or(0)
            };
            Some((name.to_string(), (n("ahead"), n("behind"))))
        })
        .collect()
}

// ---- mutations -----------------------------------------------------------

/// Check out `name` in the main worktree. Fails if the tree is dirty and git refuses.
pub fn switch_in_main(repo: &Repo, name: &str) -> Result<()> {
    git(&repo.root, ["switch", name])?;
    Ok(())
}

/// Refuse a name git would reject, or accept and regret: `@` and `HEAD` are
/// other words for the current commit, and a leading `-` reads as an option.
/// `kind` is "branch" or "tag".
pub fn check_name(name: &str, kind: &str) -> Result<()> {
    let own_rule = name.is_empty() || name.starts_with('-') || name == "@" || name == "HEAD";
    let space = if kind == "tag" { "tags" } else { "heads" };
    let valid = !own_rule
        && crate::cmd::git_raw(
            &std::env::temp_dir(),
            ["check-ref-format", &format!("refs/{space}/{name}")],
        )
        .is_ok_and(|r| r.0 == 0);
    if valid {
        return Ok(());
    }
    Err(crate::Error::Msg(format!(
        "\"{name}\" isn't a valid {kind} name. Names can't have spaces, \"..\", ~ ^ : ? * [ or \\, start with - or /, or end with / or .lock."
    )))
}

/// `git switch -c <name>` in worktree `wt`. Used to leave a detached HEAD.
pub fn create_and_switch(wt: &Path, name: &str) -> Result<()> {
    check_name(name, "branch")?;
    git(wt, ["switch", "-c", name])?;
    Ok(())
}

/// Create a local branch from `base` (default HEAD) without checking it out.
pub fn create(repo: &Repo, name: &str, base: Option<&str>) -> Result<()> {
    check_name(name, "branch")?;
    let mut args = vec!["branch", name];
    if let Some(b) = base {
        args.push(b);
    }
    git(&repo.root, &args)?;
    Ok(())
}

/// Create a local branch that tracks `remote_branch` (e.g. `origin/feat/x`).
pub fn track_remote(repo: &Repo, remote_branch: &str, local: &str) -> Result<()> {
    check_name(local, "branch")?;
    git(&repo.root, ["branch", "--track", local, remote_branch])?;
    Ok(())
}

pub fn rename(repo: &Repo, old: &str, new: &str) -> Result<()> {
    check_name(new, "branch")?;
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

/// True when everything on `upstream` (a full ref name) was on `branch` at
/// some point, going by the branch's reflog. Commits someone else pushed
/// were never here, so they make this false.
pub(crate) fn had_before(repo: &Repo, branch: &str, upstream: &str) -> bool {
    let dir = &repo.common_git_dir;
    let head = format!("refs/heads/{branch}");
    let Some(log) =
        crate::cmd::git_opt(dir, ["log", "-g", "--format=%H", "-n", "500", &head, "--"])
    else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    let mut args = vec![
        "rev-list".to_string(),
        "--count".into(),
        upstream.to_string(),
    ];
    args.extend(
        log.lines()
            .filter(|l| seen.insert(*l))
            .map(|l| format!("^{l}")),
    );
    args.push("--".into());
    crate::cmd::git_opt(dir, &args).as_deref() == Some("0")
}

/// Make the branch's upstream match the branch, replacing commits there.
/// Only when those commits were on this branch before (so nobody else's work
/// goes), and never on the default branch. The upstream's old tip is kept
/// reachable under `refs/pando/snapshots/force-push/`.
pub fn force_push(repo: &Repo, name: &str) -> Result<()> {
    let dir = &repo.common_git_dir;
    let cfg = |key: &str| crate::cmd::git_opt(dir, ["config", &format!("branch.{name}.{key}")]);
    let (Some(remote), Some(merge)) = (cfg("remote"), cfg("merge")) else {
        return Err(crate::Error::Msg(format!(
            "{name} has no upstream yet. Use Push."
        )));
    };
    let theirs = merge
        .strip_prefix("refs/heads/")
        .unwrap_or(&merge)
        .to_string();
    if repo.default_branch.as_deref() == Some(theirs.as_str()) {
        return Err(crate::Error::Msg(format!(
            "Pando doesn't force push {theirs}. Others build on it."
        )));
    }
    let tracking = format!("refs/remotes/{remote}/{theirs}");
    let Some(old) = crate::cmd::git_opt(dir, ["rev-parse", "--verify", "-q", &tracking]) else {
        return Err(crate::Error::Msg(format!(
            "{remote}/{theirs} isn't known here yet. Fetch first."
        )));
    };
    // Nothing to replace: a plain push does it.
    let ahead_only = crate::cmd::git_raw(
        dir,
        [
            "merge-base",
            "--is-ancestor",
            &old,
            &format!("refs/heads/{name}"),
        ],
    )?
    .0 == 0;
    if ahead_only {
        return push(repo, name, &remote, false);
    }
    if !had_before(repo, name, &tracking) {
        return Err(crate::Error::Msg(format!(
            "{remote}/{theirs} has commits this branch never had. Someone else may have pushed. Pull first, or look at them."
        )));
    }
    crate::backup::keep_commit(repo, "force-push", &old)?;
    git(
        &repo.root,
        [
            "push",
            "--force-with-lease",
            "--force-if-includes",
            &remote,
            &format!("refs/heads/{name}:refs/heads/{theirs}"),
        ],
    )?;
    Ok(())
}

/// Pull into the worktree that has the branch checked out.
pub fn pull(worktree: &Path, rebase: bool) -> Result<()> {
    let mut args = vec!["pull"];
    args.push(if rebase { "--rebase" } else { "--no-rebase" });
    git(worktree, &args)?;
    Ok(())
}
