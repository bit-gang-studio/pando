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
    pub push_base: bool,
    /// Remove the worktree and delete the local branch afterwards.
    pub delete_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub name: String,
    pub ok: bool,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeResult {
    pub landed: bool,
    pub steps: Vec<Step>,
    pub backup_ref: Option<String>,
}

fn local_name(base: &str) -> String {
    match base.split_once('/') {
        Some((_, rest)) => rest.to_string(),
        None => base.to_string(),
    }
}

/// The base a branch merges into: the repo's default branch.
pub fn default_base(repo: &Repo) -> Result<String> {
    repo.default_branch
        .clone()
        .ok_or_else(|| crate::Error::Config("no default branch found".into()))
}

pub fn preflight(repo: &Repo, wt: &Path, branch: &str, base: &str) -> Result<Preflight> {
    let g = repo.open_gix()?;
    let tip = g.rev_parse_single(branch).map_err(gix_err)?.detach();
    let base_id = g.rev_parse_single(base).map_err(gix_err)?.detach();
    let ahead = count_only_in(&g, tip, base_id)?;
    let behind = count_only_in(&g, base_id, tip)?;
    let summary = status::summary(wt)?;
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

    let base_local = local_name(base);
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
        wt,
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
        problems.push(format!("No commits ahead of {base}. Nothing to land."));
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

pub fn run(repo: &Repo, wt: &Path, plan: &MergePlan) -> Result<MergeResult> {
    let mut steps: Vec<Step> = vec![];
    let mut r = MergeResult {
        landed: false,
        steps: vec![],
        backup_ref: None,
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
    let base_local = local_name(base);
    step!("Backup ref", {
        let name = backup::write(repo, branch)?;
        r.backup_ref = name.clone();
        Ok(name.unwrap_or_default())
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
                if let Some((remote, _)) = base.split_once('/') {
                    let _ = git(wt, ["fetch", "-q", remote]);
                }
                match git(wt, ["rebase", base]) {
                    Ok(o) => Ok(o),
                    Err(e) => {
                        let _ = git(wt, ["rebase", "--abort"]);
                        Err(crate::Error::Config(format!(
                            "Rebase hit conflicts and was undone. Use Sync with base to resolve. {e}"
                        )))
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
                            Err(e) => {
                                let _ = git(&w.path, ["merge", "--abort"]);
                                Err(crate::Error::Config(format!(
                                "Merge hit conflicts and was undone. Use Sync with base to resolve. {e}"
                            )))
                            }
                        }
                    }
                    None => {
                        // Base isn't checked out anywhere: build the merge commit without a checkout.
                        let (code, out, err) = git_raw(
                            &repo.common_git_dir,
                            ["merge-tree", "--write-tree", &base_local, branch],
                        )?;
                        if code != 0 {
                            return Err(crate::Error::Config(format!(
                                "Merge would conflict. {err}"
                            )));
                        }
                        let tree = out.lines().next().unwrap_or("").trim().to_string();
                        let commit = git(
                            &repo.common_git_dir,
                            [
                                "commit-tree",
                                &tree,
                                "-p",
                                &base_local,
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
                            ["update-ref", &format!("refs/heads/{base_local}"), &commit],
                        )?;
                        Ok(format!("{base_local} -> {}", &commit[..7]))
                    }
                }
            });
        }
    }

    if plan.push_base {
        step!(format!("Push {base_local}"), {
            let remote = base.split_once('/').map(|(r, _)| r).unwrap_or("origin");
            git(
                &repo.root,
                ["push", "-q", remote, &format!("{base_local}:{base_local}")],
            )
        });
    }

    if plan.delete_branch {
        if wt != repo.root {
            step!("Remove worktree", {
                worktree::remove(repo, wt, true)?;
                Ok(wt.display().to_string())
            });
        }
        step!(format!("Delete branch {branch}"), {
            git(&repo.root, ["branch", "-D", "-q", branch])?;
            Ok(String::new())
        });
    }

    r.landed = true;
    r.steps = steps;
    Ok(r)
}
