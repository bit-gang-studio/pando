//! Watch a repo's worktrees and git dir, and call back when something git
//! would notice changes. Files git ignores (build output, node_modules) and
//! git's own bookkeeping (objects, logs, lock files) don't count.

use crate::cmd::git_stdin;
use crate::error::{Error, Result};
use crate::repo::Repo;
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// Keeps watching until dropped.
pub struct RepoWatcher {
    _watcher: notify::RecommendedWatcher,
}

/// How long to wait for more events before calling back.
const SETTLE: Duration = Duration::from_millis(250);

/// Watch `repo` plus each worktree folder in `worktrees`.
/// `on_change` runs on a background thread, at most once per burst of changes.
pub fn watch(
    repo: &Repo,
    worktrees: &[PathBuf],
    on_change: impl Fn() + Send + 'static,
) -> Result<RepoWatcher> {
    let git_dir = canon(&repo.common_git_dir);
    let mut roots: Vec<PathBuf> = worktrees.iter().map(|p| canon(p)).collect();
    if !roots.contains(&canon(&repo.root)) && !repo.bare {
        roots.push(canon(&repo.root));
    }
    // Longest first, so a worktree nested inside another folder matches itself.
    roots.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));

    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // Linux also reports reads (git reading its own config); only writes matter.
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })
    .map_err(watch_err)?;
    for r in &roots {
        watcher
            .watch(r, RecursiveMode::Recursive)
            .map_err(watch_err)?;
    }
    if !roots.iter().any(|r| git_dir.starts_with(r)) {
        watcher
            .watch(&git_dir, RecursiveMode::Recursive)
            .map_err(watch_err)?;
    }

    std::thread::spawn(move || {
        // Ends when the watcher is dropped and the channel closes.
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while let Ok(p) = rx.recv_timeout(SETTLE) {
                batch.push(p);
            }
            if matters(&git_dir, &roots, batch) {
                on_change();
            }
        }
    });
    Ok(RepoWatcher { _watcher: watcher })
}

/// True if any path in the batch is something git would notice.
fn matters(git_dir: &Path, roots: &[PathBuf], batch: Vec<PathBuf>) -> bool {
    let mut by_root: HashMap<&Path, HashSet<String>> = HashMap::new();
    for p in batch {
        let p = canon_lossy(&p);
        if let Ok(rel) = p.strip_prefix(git_dir) {
            if git_dir_matters(rel) {
                return true;
            }
            continue;
        }
        let Some(root) = roots.iter().find(|r| p.starts_with(r)) else {
            continue;
        };
        let rel = p.strip_prefix(root).unwrap_or(&p).to_path_buf();
        // The worktree's own folder is gone (deleted or moved by hand). The
        // system may report only this one event for it, not one per file.
        if rel.as_os_str().is_empty() && !root.exists() {
            return true;
        }
        // A linked worktree's `.git` is a file pointing at the git dir; skip it.
        // Git doesn't track folders; a change inside one also reports the file.
        if rel.as_os_str().is_empty() || rel.starts_with(".git") || p.is_dir() {
            continue;
        }
        by_root
            .entry(root.as_path())
            .or_default()
            .insert(rel.to_string_lossy().replace('\\', "/"));
    }
    by_root.into_iter().any(|(root, paths)| {
        let ignored = ignored(root, &paths);
        paths.iter().any(|p| !ignored.contains(p))
    })
}

fn git_dir_matters(rel: &Path) -> bool {
    let first = rel
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().into_owned());
    if matches!(
        first.as_deref(),
        Some("objects" | "logs" | "hooks" | "info" | "lfs")
    ) {
        return false;
    }
    let name = rel
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    !name.ends_with(".lock") && name != "FETCH_HEAD" && !name.starts_with("tmp_")
}

/// Which of `paths` git ignores. If git can't tell, none.
fn ignored(root: &Path, paths: &HashSet<String>) -> HashSet<String> {
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    match git_stdin(root, ["check-ignore", "--stdin", "-z"], &input) {
        // Exit 0: prints the ignored ones. Exit 1: none ignored.
        Ok((0, out, _)) => out
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        _ => HashSet::new(),
    }
}

fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Deleted files can't be canonicalized; canonicalize the nearest existing parent.
fn canon_lossy(p: &Path) -> PathBuf {
    if let Ok(c) = dunce::canonicalize(p) {
        return c;
    }
    let mut tail = vec![];
    let mut cur = p;
    while let Some(parent) = cur.parent() {
        if let Some(n) = cur.file_name() {
            tail.push(n.to_os_string());
        }
        if let Ok(c) = dunce::canonicalize(parent) {
            return tail.iter().rev().fold(c, |acc, n| acc.join(n));
        }
        cur = parent;
    }
    p.to_path_buf()
}

fn watch_err(e: notify::Error) -> Error {
    Error::Msg(format!("Can't watch for file changes: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dir_noise_is_ignored() {
        assert!(!git_dir_matters(Path::new("objects/ab/cdef")));
        assert!(!git_dir_matters(Path::new("index.lock")));
        assert!(!git_dir_matters(Path::new("FETCH_HEAD")));
        assert!(git_dir_matters(Path::new("refs/heads/main")));
        assert!(git_dir_matters(Path::new("HEAD")));
        assert!(git_dir_matters(Path::new("worktrees/x/index")));
    }

    #[test]
    fn a_worktree_folder_that_vanished_matters_even_as_a_single_event() {
        let tmp = tempfile::tempdir().unwrap();
        let base = canon(tmp.path());
        let (git_dir, here, gone) = (base.join("repo/.git"), base.join("here"), base.join("gone"));
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(&here).unwrap();
        let roots = vec![here.clone(), gone.clone()];
        // macOS can report a deleted folder as one event for the folder itself.
        assert!(matters(&git_dir, &roots, vec![gone.clone()]));
        // The same event for a folder that's still there is noise.
        assert!(!matters(&git_dir, &roots, vec![here.clone()]));
        // A path outside every root never matters.
        assert!(!matters(
            &git_dir,
            &roots,
            vec![base.join("elsewhere/file.txt")]
        ));
    }
}
