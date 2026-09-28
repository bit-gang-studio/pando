//! Worktrees changing the same files: they'll collide when both are merged.
//!
//! A worktree's changes are what its branch changes since it left the base
//! (`base...branch`, so a file changed and changed back doesn't count) plus
//! its uncommitted files. Any file in two worktrees' changes is an overlap.

use crate::cmd::git;
use crate::error::Result;
use crate::repo::Repo;
use crate::{status, worktree};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Overlap {
    pub a: PathBuf,
    pub b: PathBuf,
    /// Files both change, sorted.
    pub files: Vec<String>,
}

/// Every pair of worktrees whose changes share files, against `base`.
pub fn find(repo: &Repo, base: &str) -> Result<Vec<Overlap>> {
    let wts: Vec<_> = worktree::list(repo)?
        .into_iter()
        .filter(|w| !w.bare && w.prunable.is_none() && w.path.is_dir())
        .collect();
    let base_local = base
        .rsplit_once('/')
        .map(|(_, b)| b)
        .unwrap_or(base)
        .to_string();
    // One thread per worktree: each is a diff plus a status.
    let changes: HashMap<PathBuf, BTreeSet<String>> = std::thread::scope(|s| {
        let jobs: Vec<_> = wts
            .iter()
            .map(|w| {
                let base_local = base_local.clone();
                (
                    w.path.clone(),
                    s.spawn(move || changed_files(repo, w, base, &base_local)),
                )
            })
            .collect();
        jobs.into_iter()
            .filter_map(|(p, j)| j.join().ok().and_then(|r| r.ok()).map(|f| (p, f)))
            .collect()
    });
    let mut paths: Vec<&PathBuf> = changes.keys().collect();
    paths.sort();
    let mut out = Vec::new();
    for (i, a) in paths.iter().enumerate() {
        for b in &paths[i + 1..] {
            let files: Vec<String> = changes[*a].intersection(&changes[*b]).cloned().collect();
            if !files.is_empty() {
                out.push(Overlap {
                    a: (*a).clone(),
                    b: (*b).clone(),
                    files,
                });
            }
        }
    }
    Ok(out)
}

fn changed_files(
    repo: &Repo,
    w: &worktree::Worktree,
    base: &str,
    base_local: &str,
) -> Result<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    // The worktree sitting on the base has no branch changes of its own.
    let on_base = w.branch.as_deref() == Some(base_local);
    if let (false, Some(head)) = (on_base, &w.head) {
        let out = git(
            &repo.common_git_dir,
            [
                "diff",
                "--name-only",
                "-z",
                "--no-renames",
                &format!("{base}...{head}"),
            ],
        )?;
        files.extend(
            out.split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        );
    }
    files.extend(status::files(&w.path)?.into_iter().map(|f| f.path));
    Ok(files)
}
