//! A worktree is a git worktree plus what Pando attaches to it. Listing uses `git worktree list --porcelain -z`
//! because gix does not report lock or prunable state.

use crate::backup;
use crate::cmd::{git, git_bytes};
use crate::config::RepoConfig;
use crate::error::Result;
use crate::hooks::{self, HookResult};
use crate::repo::{canon, Repo};
use crate::runtime;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeKind {
    Main,
    Linked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: PathBuf,
    pub kind: WorktreeKind,
    /// Commit hash, or `None` for an unborn branch.
    pub head: Option<String>,
    /// Short branch name, or `None` when detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    /// `Some(reason)` when locked. The reason may be empty.
    pub locked: Option<String>,
    /// `Some(reason)` when git considers it prunable.
    pub prunable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddWorktree {
    pub path: PathBuf,
    pub branch: String,
    /// Start point for a new branch. Defaults to HEAD.
    pub base: Option<String>,
    /// `true` creates `branch`; `false` checks out an existing one.
    pub create_branch: bool,
}

/// High-level create: path from config, worktree add, port, hooks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateWorktree {
    pub branch: String,
    /// Start point for a new branch. Defaults to config base, then the repo default branch.
    pub base: Option<String>,
    /// Overrides the configured location template.
    pub path: Option<PathBuf>,
    /// Check out an existing branch instead of creating one.
    pub existing_branch: bool,
    pub run_hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Created {
    pub worktree: Worktree,
    pub port: Option<u16>,
    pub hooks: Vec<HookResult>,
}

pub fn create(repo: &Repo, req: &CreateWorktree) -> Result<Created> {
    let cfg = RepoConfig::load(repo)?;
    let path = req
        .path
        .clone()
        .unwrap_or_else(|| cfg.worktree_path(repo, &req.branch));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let base = if req.existing_branch {
        None
    } else {
        req.base
            .clone()
            .or_else(|| cfg.worktree.base.clone())
            .or_else(|| repo.default_branch.clone())
    };
    let worktree = add(
        repo,
        &AddWorktree {
            path,
            branch: req.branch.clone(),
            base,
            create_branch: !req.existing_branch,
        },
    )?;

    let port = match &cfg.runtime.port {
        Some(pc) => Some(runtime::assign_port(repo, &req.branch, pc)?),
        None => None,
    };

    let mut env = vec![
        (
            "PANDO_MAIN".to_string(),
            repo.root.to_string_lossy().into_owned(),
        ),
        ("PANDO_BRANCH".to_string(), req.branch.clone()),
        (
            "PANDO_WORKTREE".to_string(),
            worktree.path.to_string_lossy().into_owned(),
        ),
    ];
    if let (Some(pc), Some(p)) = (&cfg.runtime.port, port) {
        env.push((pc.env.clone(), p.to_string()));
    }
    let hooks = if req.run_hooks {
        hooks::run(&cfg.hooks.post_create, &worktree.path, &env)?
    } else {
        Vec::new()
    };

    Ok(Created {
        worktree,
        port,
        hooks,
    })
}

pub fn list(repo: &Repo) -> Result<Vec<Worktree>> {
    let out = git_bytes(&repo.root, ["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_porcelain(&out))
}

pub fn add(repo: &Repo, req: &AddWorktree) -> Result<Worktree> {
    let path = req.path.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if req.create_branch {
        args.extend(["-b".into(), req.branch.clone(), path]);
        if let Some(base) = &req.base {
            args.push(base.clone());
        }
    } else {
        args.extend([path, req.branch.clone()]);
    }
    git(&repo.root, &args)?;
    let want = canon(&req.path);
    list(repo)?
        .into_iter()
        .find(|w| w.path == want)
        .ok_or_else(|| {
            crate::Error::Gix(format!("worktree not found after add: {}", want.display()))
        })
}

/// Remove a worktree. Writes a backup ref for its branch first and frees its port.
pub fn remove(repo: &Repo, path: &Path, force: bool) -> Result<()> {
    let want = canon(path);
    if let Some(branch) = list(repo)?
        .iter()
        .find(|w| w.path == want)
        .and_then(|w| w.branch.clone())
    {
        backup::write(repo, &branch)?;
        runtime::release_port(repo, &branch)?;
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    let p = path.to_string_lossy().into_owned();
    args.push(&p);
    git(&repo.root, &args)?;
    Ok(())
}

/// Drop worktree records whose directories are gone. Returns how many.
pub fn prune(repo: &Repo) -> Result<u32> {
    let before = list(repo)?.iter().filter(|w| w.prunable.is_some()).count();
    git(&repo.root, ["worktree", "prune"])?;
    let after = list(repo)?.iter().filter(|w| w.prunable.is_some()).count();
    Ok(before.saturating_sub(after) as u32)
}

pub fn lock(repo: &Repo, path: &Path, reason: Option<&str>) -> Result<()> {
    let p = path.to_string_lossy().into_owned();
    let mut args = vec!["worktree", "lock"];
    if let Some(r) = reason {
        args.extend(["--reason", r]);
    }
    args.push(&p);
    git(&repo.root, &args)?;
    Ok(())
}

pub fn unlock(repo: &Repo, path: &Path) -> Result<()> {
    let p = path.to_string_lossy().into_owned();
    git(&repo.root, ["worktree", "unlock", &p])?;
    Ok(())
}

fn parse_porcelain(out: &[u8]) -> Vec<Worktree> {
    let text = String::from_utf8_lossy(out);
    let mut all = Vec::new();
    for (i, record) in text
        .split("\0\0")
        .filter(|r| !r.trim_matches('\0').is_empty())
        .enumerate()
    {
        let mut w = Worktree {
            path: PathBuf::new(),
            kind: if i == 0 {
                WorktreeKind::Main
            } else {
                WorktreeKind::Linked
            },
            head: None,
            branch: None,
            detached: false,
            bare: false,
            locked: None,
            prunable: None,
        };
        for line in record.split('\0').filter(|l| !l.is_empty()) {
            let (key, val) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => w.path = canon(Path::new(val)),
                "HEAD" => w.head = Some(val.to_string()).filter(|h| !h.chars().all(|c| c == '0')),
                "branch" => {
                    w.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string())
                }
                "detached" => w.detached = true,
                "bare" => w.bare = true,
                "locked" => w.locked = Some(val.to_string()),
                "prunable" => w.prunable = Some(val.to_string()),
                _ => {}
            }
        }
        all.push(w);
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_three_records() {
        let raw = "worktree /r\0HEAD abc\0branch refs/heads/main\0\0\
                   worktree /r/a\0HEAD def\0branch refs/heads/feat/a\0locked busy\0\0\
                   worktree /r/b\0HEAD 000\0detached\0prunable gitdir file points to non-existent location\0\0";
        let v = parse_porcelain(raw.as_bytes());
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].kind, WorktreeKind::Main);
        assert_eq!(v[0].branch.as_deref(), Some("main"));
        assert_eq!(v[1].locked.as_deref(), Some("busy"));
        assert_eq!(v[1].branch.as_deref(), Some("feat/a"));
        assert!(v[2].detached);
        assert!(v[2].prunable.is_some());
        assert_eq!(v[2].head, None);
    }
}
