use crate::cmd::{git, git_opt};
use crate::error::{gix_err, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A repository. `root` is the main worktree, even when discovered from a linked one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repo {
    pub root: PathBuf,
    pub common_git_dir: PathBuf,
    pub default_branch: Option<String>,
    pub bare: bool,
}

impl Repo {
    /// Find the repo that contains `path`.
    pub fn discover(path: &Path) -> Result<Repo> {
        let common = git(
            path,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .map_err(|_| Error::NotARepo(path.to_path_buf()))?;
        let common_git_dir = canon(Path::new(common.trim()));
        let bare = git_opt(&common_git_dir, ["rev-parse", "--is-bare-repository"]).as_deref()
            == Some("true");
        let root = if bare {
            common_git_dir.clone()
        } else {
            main_worktree_root(&common_git_dir, path)
                .ok_or_else(|| Error::NotARepo(path.to_path_buf()))?
        };
        let default_branch = default_branch(&common_git_dir)?;
        Ok(Repo {
            root,
            common_git_dir,
            default_branch,
            bare,
        })
    }

    pub(crate) fn open_gix(&self) -> Result<gix::Repository> {
        gix::open(&self.common_git_dir).map_err(gix_err)
    }
}

/// The main worktree for a git dir. Usually its parent, but a submodule keeps
/// its git dir under the parent's `.git/modules/` and points back with `core.worktree`.
fn main_worktree_root(common_git_dir: &Path, from: &Path) -> Option<PathBuf> {
    if let Some(rel) = git_opt(common_git_dir, ["config", "--get", "core.worktree"]) {
        return Some(canon(&common_git_dir.join(rel)));
    }
    if common_git_dir.file_name().is_some_and(|n| n == ".git") {
        return common_git_dir.parent().map(Path::to_path_buf);
    }
    git_opt(from, ["rev-parse", "--show-toplevel"]).map(|t| canon(Path::new(&t)))
}

fn default_branch(git_dir: &Path) -> Result<Option<String>> {
    if let Some(head) = git_opt(
        git_dir,
        ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
    ) {
        return Ok(Some(head.trim_start_matches("origin/").to_string()));
    }
    let repo = gix::open(git_dir).map_err(gix_err)?;
    for name in ["main", "master", "trunk"] {
        if repo.find_reference(&format!("refs/heads/{name}")).is_ok() {
            return Ok(Some(name.to_string()));
        }
    }
    Ok(None)
}

/// Resolve symlinks (macOS `/var` -> `/private/var`) without Windows `\\?\` prefixes.
pub(crate) fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}
