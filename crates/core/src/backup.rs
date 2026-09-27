//! Safety nets. Written before any change that could lose work.
//!
//! - Branch backups: `refs/pando/backup/<branch>`, the tip before a change.
//!   Each write is kept in that ref's reflog, so older backups survive too.
//! - Snapshots: `refs/pando/snapshots/<what>/<time>`, a commit holding the
//!   files a discard, forced worktree removal or stash drop is about to lose.
//!
//! Neither is ever pushed. Nothing here changes files on disk.

use crate::cmd::{git, git_env, git_opt};
use crate::error::Result;
use crate::repo::Repo;
use std::ffi::OsStr;
use std::path::Path;

pub const PREFIX: &str = "refs/pando/backup/";
pub const SNAPSHOTS: &str = "refs/pando/snapshots/";

/// Copy `refs/heads/<branch>` to `refs/pando/backup/<branch>`.
/// Returns the backup ref name, or `None` if the branch does not exist.
pub fn write(repo: &Repo, branch: &str) -> Result<Option<String>> {
    let head = format!("refs/heads/{branch}");
    if git_opt(&repo.common_git_dir, ["rev-parse", "--verify", "-q", &head]).is_none() {
        return Ok(None);
    }
    let name = format!("{PREFIX}{branch}");
    git(
        &repo.common_git_dir,
        [
            "update-ref",
            "--create-reflog",
            "-m",
            "pando backup",
            &name,
            &head,
        ],
    )?;
    Ok(Some(name))
}

/// Save the current contents of `paths` in `worktree` (tracked or new files;
/// empty means every change) as a commit on top of HEAD, under
/// `refs/pando/snapshots/<what>/<time>`. Returns the ref, or `None` if there
/// was nothing to save.
pub fn snapshot(
    repo: &Repo,
    worktree: &Path,
    what: &str,
    paths: &[String],
) -> Result<Option<String>> {
    let index = repo
        .common_git_dir
        .join(format!("pando-snapshot-{}.index", std::process::id()));
    let env: [(&str, &OsStr); 5] = [
        ("GIT_INDEX_FILE", index.as_os_str()),
        ("GIT_AUTHOR_NAME", OsStr::new("Pando")),
        ("GIT_AUTHOR_EMAIL", OsStr::new("pando@localhost")),
        ("GIT_COMMITTER_NAME", OsStr::new("Pando")),
        ("GIT_COMMITTER_EMAIL", OsStr::new("pando@localhost")),
    ];
    let head = git_opt(worktree, ["rev-parse", "--verify", "-q", "HEAD"]);
    let result = (|| {
        match &head {
            Some(h) => git_env(worktree, &env, ["read-tree", h.as_str()])?,
            None => git_env(worktree, &env, ["read-tree", "--empty"])?,
        };
        let mut add = vec!["add", "-A", "--"];
        if paths.is_empty() {
            add.push(".");
        } else {
            add.extend(paths.iter().map(String::as_str));
        }
        git_env(worktree, &env, &add)?;
        let tree = git_env(worktree, &env, ["write-tree"])?.trim().to_string();
        if let Some(h) = &head {
            let head_tree = git(worktree, ["rev-parse", &format!("{h}^{{tree}}")])?;
            if head_tree.trim() == tree {
                return Ok(None);
            }
        }
        let mut commit = vec!["commit-tree", tree.as_str(), "-m", "pando snapshot"];
        if let Some(h) = &head {
            commit.extend(["-p", h.as_str()]);
        }
        let id = git_env(worktree, &env, &commit)?.trim().to_string();
        let name = format!("{SNAPSHOTS}{what}/{}", stamp());
        git(worktree, ["update-ref", &name, &id])?;
        Ok(Some(name))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Keep a dropped stash reachable at `refs/pando/snapshots/stash/<time>`.
pub fn keep_commit(repo: &Repo, what: &str, id: &str) -> Result<String> {
    let name = format!("{SNAPSHOTS}{what}/{}", stamp());
    git(&repo.common_git_dir, ["update-ref", &name, id])?;
    Ok(name)
}

/// Sortable and unique enough: nanoseconds since the epoch.
fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
