//! Backup refs. Written before any mutation so Undo and Abort are safe.

use crate::cmd::{git, git_opt};
use crate::error::Result;
use crate::repo::Repo;

pub const PREFIX: &str = "refs/pando/backup/";

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
        ["update-ref", "-m", "pando backup", &name, &head],
    )?;
    Ok(Some(name))
}
