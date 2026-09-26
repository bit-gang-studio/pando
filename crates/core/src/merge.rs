//! Merge a branch into its base: preflight, then a job made of steps.
//! Rebase first, optionally squash, fast-forward the base, remove the worktree.

use crate::backup;
use crate::branch::count_only_in;
use crate::cmd::{git, git_raw};
use crate::config::RepoConfig;
use crate::error::{gix_err, Result};
use crate::hooks;
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
    pub pre_land_hooks: Vec<String>,
    pub squash_default: bool,
    pub remove_worktree_default: bool,
    pub delete_branch_default: bool,
    /// Blocking problems. Empty means Land can run.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Destination {
    /// Fast-forward the local base branch to the landed commits, optionally push it.
    LocalMerge,
    /// Only push the branch (for a PR made elsewhere).
    PushBranch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergePlan {
    pub branch: String,
    pub base: String,
    pub squash: bool,
    pub message: Option<String>,
    pub destination: Destination,
    pub push_base: bool,
    pub run_hooks: bool,
    pub remove_worktree: bool,
    pub delete_branch: bool,
    pub delete_remote: bool,
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

/// The base a branch lands into: config base, else the repo default branch.
pub fn default_base(repo: &Repo) -> Result<String> {
    let cfg = RepoConfig::load(repo)?;
    cfg.worktree
        .base
        .or_else(|| repo.default_branch.clone())
        .ok_or_else(|| {
            crate::Error::Config("no default branch; set [worktree] base in .pando.toml".into())
        })
}

pub fn preflight(repo: &Repo, wt: &Path, branch: &str, base: &str) -> Result<Preflight> {
    let cfg = RepoConfig::load(repo)?;
    let g = repo.open_gix()?;
    let tip = g.rev_parse_single(branch).map_err(gix_err)?.detach();
    let base_id = g.rev_parse_single(base).map_err(gix_err)?.detach();
    let ahead = count_only_in(&g, tip, base_id)?;
    let behind = count_only_in(&g, base_id, tip)?;
    let clean = status::summary(wt)?.is_clean();

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
        problems.push("Uncommitted changes in this worktree. Commit or stash first.".into());
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
        pre_land_hooks: cfg.hooks.pre_land,
        squash_default: cfg.land.strategy == "squash",
        remove_worktree_default: cfg.land.remove_worktree,
        delete_branch_default: cfg.land.delete_branch,
        problems,
    })
}

pub fn run(repo: &Repo, wt: &Path, plan: &MergePlan) -> Result<MergeResult> {
    let cfg = RepoConfig::load(repo)?;
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
    let env = vec![
        (
            "PANDO_MAIN".to_string(),
            repo.root.to_string_lossy().into_owned(),
        ),
        ("PANDO_BRANCH".to_string(), branch.to_string()),
        ("PANDO_BASE".to_string(), base.to_string()),
    ];

    step!("Backup ref", {
        let name = backup::write(repo, branch)?;
        r.backup_ref = name.clone();
        Ok(name.unwrap_or_default())
    });

    if plan.run_hooks && !cfg.hooks.pre_land.is_empty() {
        step!("Before-land hooks", {
            let results = hooks::run(&cfg.hooks.pre_land, wt, &env)?;
            let mut out = String::new();
            for h in &results {
                out.push_str(&format!(
                    "{} {}\n{}{}",
                    if h.ok() { "ok  " } else { "FAIL" },
                    h.command,
                    h.stdout,
                    h.stderr
                ));
                if !h.ok() {
                    return Err(crate::Error::Config(out));
                }
            }
            Ok(out)
        });
    }

    step!(format!("Rebase onto {base}"), {
        if let Some((remote, _)) = base.split_once('/') {
            let _ = git(wt, ["fetch", "-q", remote]);
        }
        match git(wt, ["rebase", base]) {
            Ok(o) => Ok(o),
            Err(e) => {
                let _ = git(wt, ["rebase", "--abort"]);
                Err(crate::Error::Config(format!(
                    "Rebase hit conflicts and was undone. {e}"
                )))
            }
        }
    });

    if plan.squash {
        step!("Squash commits", {
            let msg = plan
                .message
                .clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| format!("Merge {branch}"));
            git(wt, ["reset", "-q", "--soft", base])?;
            git(wt, ["commit", "-q", "-m", &msg])?;
            Ok(git(wt, ["rev-parse", "--short", "HEAD"])?
                .trim()
                .to_string())
        });
    }

    match plan.destination {
        Destination::LocalMerge => {
            step!(format!("Fast-forward {base_local}"), {
                let wts = worktree::list(repo)?;
                let base_wt = wts
                    .iter()
                    .find(|w| w.branch.as_deref() == Some(base_local.as_str()));
                match base_wt {
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
            if plan.push_base {
                step!(format!("Push {base_local}"), {
                    let remote = base.split_once('/').map(|(r, _)| r).unwrap_or("origin");
                    git(
                        &repo.root,
                        ["push", "-q", remote, &format!("{base_local}:{base_local}")],
                    )
                });
            }
        }
        Destination::PushBranch => {
            step!(format!("Push {branch}"), {
                git(
                    wt,
                    ["push", "-q", "-u", "--force-with-lease", "origin", branch],
                )
            });
        }
    }

    if plan.run_hooks && !cfg.hooks.post_land.is_empty() {
        step!("After-land hooks", {
            let results = hooks::run(&cfg.hooks.post_land, &repo.root, &env)?;
            Ok(results
                .iter()
                .map(|h| format!("{} {}", if h.ok() { "ok  " } else { "FAIL" }, h.command))
                .collect::<Vec<_>>()
                .join("\n"))
        });
    }

    if plan.remove_worktree && wt != repo.root {
        step!("Remove worktree", {
            worktree::remove(repo, wt, true)?;
            Ok(wt.display().to_string())
        });
    }
    if plan.delete_branch && plan.destination == Destination::LocalMerge {
        step!(format!("Delete branch {branch}"), {
            git(&repo.root, ["branch", "-D", "-q", branch])?;
            Ok(String::new())
        });
        if plan.delete_remote {
            step!("Delete remote branch", {
                git(&repo.root, ["push", "-q", "origin", "--delete", branch])
            });
        }
    }

    r.landed = true;
    r.steps = steps;
    Ok(r)
}
