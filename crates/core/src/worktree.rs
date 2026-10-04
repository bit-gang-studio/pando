//! A worktree is a git worktree plus what Pando attaches to it. Listing uses `git worktree list --porcelain -z`
//! because gix does not report lock or prunable state.

use crate::backup;
use crate::cmd::{git, git_bytes};
use crate::error::Result;
use crate::repo::{canon, Repo};
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

/// High-level create: pick a sibling folder, run `git worktree add`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateWorktree {
    pub branch: String,
    /// Start point for a new branch. Defaults to the repo's default branch.
    pub base: Option<String>,
    /// Overrides the default sibling folder.
    pub path: Option<PathBuf>,
    /// Check out an existing branch instead of creating one.
    pub existing_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Created {
    pub worktree: Worktree,
}

/// Where a new worktree goes by default: next to the repo, `<repo>-<branch-slug>`.
pub fn default_path(repo: &Repo, branch: &str) -> PathBuf {
    let name = repo
        .root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let parent = repo
        .root
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo.root.clone());
    // Different branches can share a slug (`a/b-c`, `a-b/c`): never reuse a folder.
    let first = parent.join(format!("{name}-{}", branch_slug(branch)));
    let mut path = first.clone();
    let mut n = 2;
    while path.exists() {
        path = PathBuf::from(format!("{}-{n}", first.display()));
        n += 1;
    }
    path
}

/// `feat/Auth Refresh` -> `feat-auth-refresh`
pub fn branch_slug(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    let mut last_dash = false;
    for c in branch.chars() {
        if c.is_alphanumeric() || c == '.' || c == '_' {
            out.extend(c.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

pub fn create(repo: &Repo, req: &CreateWorktree) -> Result<Created> {
    let path = req
        .path
        .clone()
        .unwrap_or_else(|| default_path(repo, &req.branch));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let base = if req.existing_branch {
        None
    } else {
        req.base.clone().or_else(|| repo.default_branch.clone())
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
    Ok(Created { worktree })
}

pub fn list(repo: &Repo) -> Result<Vec<Worktree>> {
    let out = git_bytes(&repo.root, ["worktree", "list", "--porcelain", "-z"])?;
    let mut all = parse_porcelain(&out);
    // A submodule reports its git dir as the main worktree path. Use the real root.
    if let Some(main) = all.iter_mut().find(|w| w.kind == WorktreeKind::Main) {
        if !repo.bare && main.path != repo.root {
            main.path = repo.root.clone();
        }
    }
    Ok(all)
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

/// Remove a worktree. Writes a backup ref for its branch first.
/// What a removal took away, so Undo can put it back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Removed {
    pub path: PathBuf,
    pub branch: Option<String>,
    /// The commit it had checked out (for a detached worktree).
    pub head: Option<String>,
    /// Uncommitted changes saved before a forced removal.
    pub snapshot: Option<String>,
}

pub fn remove(repo: &Repo, path: &Path, force: bool) -> Result<Removed> {
    let want = canon(path);
    let w = list(repo)?.into_iter().find(|w| w.path == want);
    let branch = w.as_ref().and_then(|w| w.branch.clone());
    if let Some(b) = &branch {
        backup::write(repo, b)?;
    }
    // Forcing throws away uncommitted changes; save them first.
    let snapshot = if force && path.is_dir() {
        backup::snapshot(repo, path, "remove-worktree", &[])?
    } else {
        None
    };
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    let p = path.to_string_lossy().into_owned();
    args.push(&p);
    git(&repo.root, &args)?;
    Ok(Removed {
        path: want,
        branch,
        head: w.and_then(|w| w.head),
        snapshot,
    })
}

/// Undo `remove`: add the worktree back in the same folder, on the same
/// branch (or commit), with any saved uncommitted changes.
pub fn undo_remove(repo: &Repo, r: &Removed) -> Result<()> {
    if r.path.exists() {
        return Err(crate::Error::Msg(format!(
            "{} exists again, so it can't be put back.",
            r.path.display()
        )));
    }
    let p = r.path.to_string_lossy().into_owned();
    match (&r.branch, &r.head) {
        (Some(b), _) => git(&repo.root, ["worktree", "add", "-q", &p, b])?,
        (None, Some(h)) => git(&repo.root, ["worktree", "add", "-q", "--detach", &p, h])?,
        (None, None) => return Err(crate::Error::Msg("Nothing to put back".into())),
    };
    if let Some(snap) = &r.snapshot {
        backup::restore_files(repo, snap, &r.path)?;
    }
    Ok(())
}

/// Drop worktree records whose directories are gone. Returns how many.
pub fn prune(repo: &Repo) -> Result<u32> {
    let before = list(repo)?.iter().filter(|w| w.prunable.is_some()).count();
    git(&repo.root, ["worktree", "prune"])?;
    let after = list(repo)?.iter().filter(|w| w.prunable.is_some()).count();
    Ok(before.saturating_sub(after) as u32)
}

/// `git worktree repair`: reconnect a worktree whose folder was moved by hand.
/// `moved_to` is where the folder is now. Only fixes git's two pointer files;
/// nothing in the folder changes. Refuses a folder that isn't this repo's worktree.
pub fn repair(repo: &Repo, moved_to: &Path) -> Result<()> {
    let not_ours = || {
        crate::Error::Msg(format!(
            "{} isn't a worktree of this repository.",
            moved_to.display()
        ))
    };
    // A linked worktree's `.git` is a file: "gitdir: <repo>/.git/worktrees/<id>".
    let pointer = std::fs::read_to_string(moved_to.join(".git")).map_err(|_| not_ours())?;
    let gitdir = pointer
        .lines()
        .find_map(|l| l.strip_prefix("gitdir:"))
        .map(|p| PathBuf::from(p.trim()))
        .ok_or_else(not_ours)?;
    let same = |a: &Path, b: &Path| match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    let ours = gitdir
        .parent()
        .is_some_and(|p| same(p, &repo.common_git_dir.join("worktrees")));
    if !ours || !gitdir.is_dir() {
        return Err(not_ours());
    }
    git(
        &repo.root,
        ["worktree", "repair", &moved_to.to_string_lossy()],
    )?;
    Ok(())
}

/// `git worktree move`: put the worktree's folder somewhere else.
/// Move a worktree to exactly `to`. Fails if `to` exists: `git worktree move`
/// would otherwise move it *inside* that folder.
pub fn move_to(repo: &Repo, from: &Path, to: &Path) -> Result<()> {
    if to.exists() {
        return Err(crate::Error::Msg(format!(
            "{} already exists. Pick a new folder.",
            to.display()
        )));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let (f, t) = (
        from.to_string_lossy().into_owned(),
        to.to_string_lossy().into_owned(),
    );
    git(&repo.root, ["worktree", "move", &f, &t])?;
    Ok(())
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
    fn slugs() {
        assert_eq!(branch_slug("feat/Auth Refresh"), "feat-auth-refresh");
        assert_eq!(branch_slug("fix/a..b__c"), "fix-a..b__c");
        assert_eq!(branch_slug("/x/"), "x");
    }

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
