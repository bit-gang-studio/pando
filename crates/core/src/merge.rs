//! Merge a branch into its base: preflight, then a job made of steps.
//! Three styles, named like GitHub's: merge commit, squash and merge,
//! rebase and merge.

use crate::backup;
use crate::branch::count_only_in;
use crate::cmd::{git, git_raw};
use crate::error::{gix_err, Result};
use crate::repo::Repo;
use crate::status;
use crate::worktree;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preflight {
    pub branch: String,
    pub base: String,
    /// Local branch that `base` maps to (`origin/main` -> `main`).
    pub base_local: String,
    pub clean: bool,
    pub ahead: u32,
    pub behind: u32,
    pub conflict_predicted: bool,
    pub conflict_files: Vec<String>,
    pub base_checked_out_in: Option<PathBuf>,
    pub base_worktree_clean: Option<bool>,
    pub has_upstream: bool,
    /// Summary of the branch's newest commit, for a default message.
    pub last_summary: Option<String>,
    /// Number of uncommitted changes in the worktree.
    pub uncommitted: u32,
    /// Blocking problems. Empty means Merge can run.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// `git merge --no-ff`: keeps every commit and adds a merge commit.
    MergeCommit,
    /// One new commit on the base with all the branch's changes.
    Squash,
    /// Replay the branch's commits on top of the base, then fast-forward.
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergePlan {
    pub branch: String,
    pub base: String,
    pub strategy: Strategy,
    /// Commit message for merge commit and squash. Ignored for rebase.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub name: String,
    pub ok: bool,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeResult {
    pub merged: bool,
    pub steps: Vec<Step>,
    /// Backups of the branch and the base, taken before anything moved.
    pub backup_refs: Vec<String>,
}

/// The remote a base lives on, if it's a remote branch: "origin/main" is
/// ("origin", "main"). A local branch with a slash in its name, like
/// "release/1.0", is not: taking it for one merged into a branch named "1.0".
pub(crate) fn remote_of(repo: &Repo, base: &str) -> Option<(String, String)> {
    let dir = &repo.common_git_dir;
    let exists =
        |r: String| crate::cmd::git_opt(dir, ["rev-parse", "--verify", "-q", &r]).is_some();
    if exists(format!("refs/heads/{base}")) || !exists(format!("refs/remotes/{base}")) {
        return None;
    }
    base.split_once('/')
        .map(|(r, b)| (r.to_string(), b.to_string()))
}

/// What to say when a merge can't go through cleanly. Nothing has changed.
fn clash(branch: &str, base: &str) -> String {
    format!("{branch} and {base} change the same lines, so it was left as it was. Use Sync with {base} to resolve the conflicts, then merge.")
}

pub(crate) fn local_name(repo: &Repo, base: &str) -> String {
    remote_of(repo, base)
        .map(|(_, b)| b)
        .unwrap_or_else(|| base.to_string())
}

/// The base a branch merges into: the repo's default branch.
pub fn default_base(repo: &Repo) -> Result<String> {
    repo.default_branch
        .clone()
        .ok_or_else(|| crate::Error::Msg("no default branch found".into()))
}

/// What to compare branches against: `origin/<default>` when it exists, since
/// a local default branch can be behind; else the local default branch.
pub fn compare_base(repo: &Repo) -> Option<String> {
    let b = repo.default_branch.clone()?;
    let remote = format!("origin/{b}");
    let has_remote = crate::cmd::git_opt(
        &repo.common_git_dir,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/remotes/{remote}"),
        ],
    )
    .is_some();
    Some(if has_remote { remote } else { b })
}

/// `wt` is the branch's worktree, or `None` for a branch without one.
pub fn preflight(repo: &Repo, wt: Option<&Path>, branch: &str, base: &str) -> Result<Preflight> {
    let g = repo.open_gix()?;
    let tip = g.rev_parse_single(branch).map_err(gix_err)?.detach();
    let base_id = g.rev_parse_single(base).map_err(gix_err)?.detach();
    let ahead = count_only_in(repo, &tip.to_string(), &base_id.to_string())?;
    let behind = count_only_in(repo, &base_id.to_string(), &tip.to_string())?;
    let summary = wt.map(status::summary).transpose()?.unwrap_or_default();
    let clean = summary.is_clean();
    let last_summary = g
        .find_commit(tip)
        .ok()
        .and_then(|c| c.message().ok().map(|m| m.summary().to_string()));

    let (code, out, _) = git_raw(
        &repo.common_git_dir,
        [
            "merge-tree",
            "--write-tree",
            "--no-messages",
            "--name-only",
            base,
            branch,
        ],
    )?;
    let conflict_predicted = code == 1;
    let conflict_files = if conflict_predicted {
        out.lines()
            .skip(1)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        vec![]
    };

    let base_local = local_name(repo, base);
    let wts = worktree::list(repo)?;
    let base_wt = wts
        .iter()
        .find(|w| w.branch.as_deref() == Some(base_local.as_str()));
    let base_checked_out_in = base_wt.map(|w| w.path.clone());
    let base_worktree_clean = base_wt.map(|w| {
        status::summary(&w.path)
            .map(|s| s.is_clean())
            .unwrap_or(false)
    });
    let has_upstream = git_raw(
        wt.unwrap_or(&repo.root),
        [
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    )?
    .0 == 0;

    let mut problems = vec![];
    if !clean {
        let n = summary.changed();
        problems.push(format!(
            "Commit or stash the {n} {} in this worktree first.",
            if n == 1 { "change" } else { "changes" }
        ));
    }
    if ahead == 0 {
        problems.push(format!("No commits ahead of {base}. Nothing to merge."));
    }
    if conflict_predicted {
        problems.push(format!(
            "Rebasing onto {base} will conflict in {} file(s).",
            conflict_files.len()
        ));
    }
    if base_worktree_clean == Some(false) {
        problems.push(format!(
            "The worktree with {base_local} checked out has uncommitted changes."
        ));
    }

    Ok(Preflight {
        branch: branch.to_string(),
        base: base.to_string(),
        base_local,
        clean,
        ahead,
        behind,
        conflict_predicted,
        conflict_files,
        base_checked_out_in,
        base_worktree_clean,
        has_upstream,
        last_summary,
        uncommitted: summary.changed(),
        problems,
    })
}

/// `wt` is the branch's worktree. For a branch without one, pass `None`:
/// the merge runs in a temporary worktree that is removed afterwards.
pub fn run(repo: &Repo, wt: Option<&Path>, plan: &MergePlan) -> Result<MergeResult> {
    if let Some(wt) = wt {
        return run_in(repo, wt, plan);
    }
    // A fresh folder every time, so a crash or a second merge never collides.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!(
        "pando-merge-{}-{stamp}-{}",
        std::process::id(),
        worktree::branch_slug(&plan.branch)
    ));
    let tmp_s = tmp.to_string_lossy().to_string();
    git(&repo.root, ["worktree", "add", "-q", &tmp_s, &plan.branch])?;
    let r = run_in(repo, &tmp, plan);
    if git(&repo.root, ["worktree", "remove", "--force", &tmp_s]).is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = git(&repo.root, ["worktree", "prune"]);
    }
    r
}

fn run_in(repo: &Repo, wt: &Path, plan: &MergePlan) -> Result<MergeResult> {
    let mut steps: Vec<Step> = vec![];
    let mut r = MergeResult {
        merged: false,
        steps: vec![],
        backup_refs: vec![],
    };
    macro_rules! step {
        ($name:expr, $body:expr) => {{
            #[allow(clippy::redundant_closure_call)]
            let res: Result<String> = (|| $body)();
            match res {
                Ok(out) => steps.push(Step {
                    name: $name.into(),
                    ok: true,
                    output: out,
                }),
                Err(e) => {
                    steps.push(Step {
                        name: $name.into(),
                        ok: false,
                        output: e.to_string(),
                    });
                    r.steps = steps;
                    return Ok(r);
                }
            }
        }};
    }

    let branch = plan.branch.as_str();
    let base = plan.base.as_str();
    let base_local = local_name(repo, base);
    step!("Check", {
        let ahead = git(
            &repo.common_git_dir,
            ["rev-list", "--count", &format!("{base}..{branch}")],
        )?;
        if ahead.trim() == "0" {
            return Err(crate::Error::Msg(format!(
                "{branch} has no commits that aren't on {base_local}. Nothing to merge."
            )));
        }
        Ok(format!("{} commits to merge", ahead.trim()))
    });
    // Both can move: rebase and squash rewrite the branch, every style moves the base.
    step!("Backup refs", {
        for b in [branch, base_local.as_str()] {
            if let Some(name) = backup::write(repo, b)? {
                r.backup_refs.push(name);
            }
        }
        Ok(r.backup_refs.join(", "))
    });

    let message = plan
        .message
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| format!("Merge branch '{branch}'"));
    let base_wt = worktree::list(repo)?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(base_local.as_str()));

    match plan.strategy {
        Strategy::Rebase | Strategy::Squash => {
            step!(format!("Rebase onto {base}"), {
                if let Some((remote, _)) = remote_of(repo, base) {
                    let _ = git(wt, ["fetch", "-q", &remote]);
                }
                match git(wt, ["rebase", base]) {
                    Ok(o) => Ok(o),
                    Err(_) => {
                        let _ = git(wt, ["rebase", "--abort"]);
                        Err(crate::Error::Msg(clash(branch, base)))
                    }
                }
            });
            if plan.strategy == Strategy::Squash {
                step!("Squash into one commit", {
                    git(wt, ["reset", "-q", "--soft", base])?;
                    git(wt, ["commit", "-q", "-m", &message])?;
                    Ok(git(wt, ["rev-parse", "--short", "HEAD"])?
                        .trim()
                        .to_string())
                });
            }
            step!(format!("Fast-forward {base_local}"), {
                match &base_wt {
                    Some(w) => {
                        git(&w.path, ["merge", "--ff-only", "-q", branch])?;
                        Ok(format!("{base_local} in {}", w.path.display()))
                    }
                    None => {
                        let tip = git(wt, ["rev-parse", branch])?.trim().to_string();
                        git(
                            &repo.common_git_dir,
                            ["update-ref", &format!("refs/heads/{base_local}"), &tip],
                        )?;
                        Ok(format!("{base_local} -> {}", &tip[..7]))
                    }
                }
            });
        }
        Strategy::MergeCommit => {
            step!(format!("Merge into {base_local}"), {
                match &base_wt {
                    Some(w) => {
                        match git(&w.path, ["merge", "--no-ff", "-q", "-m", &message, branch]) {
                            Ok(o) => Ok(o),
                            Err(_) => {
                                let _ = git(&w.path, ["merge", "--abort"]);
                                Err(crate::Error::Msg(clash(branch, base)))
                            }
                        }
                    }
                    None => {
                        // Base isn't checked out anywhere: build the merge commit without a checkout.
                        let (code, out, err) = git_raw(
                            &repo.common_git_dir,
                            ["merge-tree", "--write-tree", &base_local, branch],
                        )?;
                        // 1 means conflicts; anything else is a real failure.
                        if code == 1 {
                            return Err(crate::Error::Msg(clash(branch, base)));
                        }
                        if code != 0 {
                            return Err(crate::Error::Git {
                                cmd: "merge-tree".into(),
                                stderr: err.trim().to_string(),
                            });
                        }
                        // Only move the base if it's still where the merge was built.
                        let was = git(
                            &repo.common_git_dir,
                            ["rev-parse", &format!("refs/heads/{base_local}")],
                        )?
                        .trim()
                        .to_string();
                        let tree = out.lines().next().unwrap_or("").trim().to_string();
                        let commit = git(
                            &repo.common_git_dir,
                            [
                                "commit-tree",
                                &tree,
                                "-p",
                                &was,
                                "-p",
                                branch,
                                "-m",
                                &message,
                            ],
                        )?
                        .trim()
                        .to_string();
                        git(
                            &repo.common_git_dir,
                            [
                                "update-ref",
                                &format!("refs/heads/{base_local}"),
                                &commit,
                                &was,
                            ],
                        )?;
                        Ok(format!("{base_local} -> {}", &commit[..7]))
                    }
                }
            });
        }
    }

    r.merged = true;
    r.steps = steps;
    Ok(r)
}
