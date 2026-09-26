//! Find and remove worktrees that are done with.

use crate::backup;
use crate::branch::count_only_in;
use crate::cmd::{git, git_raw};
use crate::error::{gix_err, Result};
use crate::land::{self, Step};
use crate::repo::Repo;
use crate::status;
use crate::worktree::{self, WorktreeKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const IDLE_DAYS: i64 = 14;
pub const DIRTY_IDLE_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// Every commit is already in the base branch.
    Merged,
    /// The directory is gone; git still lists it.
    Missing,
    /// No commits ahead, no changes, idle for a while.
    Empty,
    /// Uncommitted changes, but idle for a long time.
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub reason: Reason,
    pub detail: String,
    /// Commits not on the base and not on any upstream.
    pub unpushed: bool,
    pub dirty: u32,
    pub disk_bytes: u64,
    pub last_commit_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanRequest {
    pub paths: Vec<PathBuf>,
    pub delete_branches: bool,
    pub delete_remote: bool,
    pub skip_unpushed: bool,
}

pub fn plan(repo: &Repo) -> Result<Vec<Candidate>> {
    let base = land::default_base(repo)?;
    let g = repo.open_gix()?;
    let base_id = g.rev_parse_single(base.as_str()).map_err(gix_err)?.detach();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut out = Vec::new();

    for w in worktree::list(repo)? {
        if w.kind == WorktreeKind::Main || w.locked.is_some() {
            continue;
        }
        if w.prunable.is_some() || !w.path.is_dir() {
            out.push(Candidate {
                path: w.path.clone(),
                branch: w.branch.clone(),
                reason: Reason::Missing,
                detail: "directory missing on disk".into(),
                unpushed: false,
                dirty: 0,
                disk_bytes: 0,
                last_commit_at: None,
            });
            continue;
        }
        let Some(branch) = w.branch.clone() else {
            continue;
        };
        let tip = match g.rev_parse_single(branch.as_str()) {
            Ok(t) => t.detach(),
            Err(_) => continue,
        };
        let ahead_of_base = count_only_in(&g, tip, base_id)?;
        let dirty = status::summary(&w.path).map(|s| s.changed()).unwrap_or(0);
        let last = g
            .find_commit(tip)
            .ok()
            .and_then(|c| c.time().ok())
            .map(|t| t.seconds);
        let idle_days = last.map(|t| (now - t) / 86400).unwrap_or(0);
        let unpushed = ahead_of_base > 0 && {
            let (code, up, _) = git_raw(&w.path, ["rev-parse", &format!("{branch}@{{upstream}}")])?;
            if code != 0 {
                true
            } else {
                let up_id = gix::ObjectId::from_hex(up.trim().as_bytes()).map_err(gix_err)?;
                count_only_in(&g, tip, up_id)? > 0
            }
        };

        let worked = reflog_entries(repo, &branch) > 1;
        let (reason, detail) = if ahead_of_base == 0 && dirty == 0 && worked {
            (Reason::Merged, format!("all commits are in {base}"))
        } else if ahead_of_base == 0 && dirty == 0 && idle_days >= IDLE_DAYS {
            (
                Reason::Empty,
                format!("no commits ahead of {base}, idle {idle_days}d"),
            )
        } else if dirty > 0 && idle_days >= DIRTY_IDLE_DAYS {
            (
                Reason::Idle,
                format!("{dirty} uncommitted changes, idle {idle_days}d"),
            )
        } else {
            continue;
        };

        out.push(Candidate {
            path: w.path.clone(),
            branch: Some(branch),
            reason,
            detail,
            unpushed,
            dirty,
            disk_bytes: dir_size(&w.path),
            last_commit_at: last,
        });
    }
    Ok(out)
}

/// Reflog entries for a branch. A fresh branch has one ("Created from"); any
/// commit adds more, so more than one means work happened on it.
fn reflog_entries(repo: &Repo, branch: &str) -> usize {
    git_raw(
        &repo.common_git_dir,
        [
            "reflog",
            "show",
            "--format=%H",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map(|(_, out, _)| out.lines().filter(|l| !l.is_empty()).count())
    .unwrap_or(0)
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                if e.file_name() != ".git" {
                    stack.push(e.path());
                }
            } else {
                total += meta.len();
            }
        }
    }
    total
}

pub fn run(repo: &Repo, req: &CleanRequest) -> Result<Vec<Step>> {
    let mut steps = Vec::new();
    let candidates = plan(repo)?;
    for path in &req.paths {
        let c = candidates.iter().find(|c| &c.path == path);
        let branch = c.and_then(|c| c.branch.clone());
        if req.skip_unpushed && c.map(|c| c.unpushed).unwrap_or(false) {
            steps.push(Step {
                name: format!("Skip {} (unpushed work)", path.display()),
                ok: true,
                output: String::new(),
            });
            continue;
        }
        let name = branch.clone().unwrap_or_else(|| path.display().to_string());
        match worktree::remove(repo, path, true).or_else(|_| worktree::prune(repo).map(|_| ())) {
            Ok(_) => steps.push(Step {
                name: format!("Remove worktree {name}"),
                ok: true,
                output: String::new(),
            }),
            Err(e) => {
                steps.push(Step {
                    name: format!("Remove worktree {name}"),
                    ok: false,
                    output: e.to_string(),
                });
                continue;
            }
        }
        if let (true, Some(b)) = (req.delete_branches, &branch) {
            let _ = backup::write(repo, b);
            match git(&repo.root, ["branch", "-D", "-q", b]) {
                Ok(_) => steps.push(Step {
                    name: format!("Delete branch {b}"),
                    ok: true,
                    output: String::new(),
                }),
                Err(e) => steps.push(Step {
                    name: format!("Delete branch {b}"),
                    ok: false,
                    output: e.to_string(),
                }),
            }
            if req.delete_remote {
                match git(&repo.root, ["push", "-q", "origin", "--delete", b]) {
                    Ok(_) => steps.push(Step {
                        name: format!("Delete origin/{b}"),
                        ok: true,
                        output: String::new(),
                    }),
                    Err(e) => steps.push(Step {
                        name: format!("Delete origin/{b}"),
                        ok: false,
                        output: e.to_string(),
                    }),
                }
            }
        }
    }
    Ok(steps)
}
