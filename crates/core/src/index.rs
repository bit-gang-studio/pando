//! Staging: files, hunks, discard.

use crate::cmd::{git, git_stdin};
use crate::diff::{hunk_patch, Hunk};
use crate::error::Result;
use crate::repo::Repo;
use std::path::Path;

pub fn stage(worktree: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(worktree, &args)?;
    Ok(())
}

pub fn unstage(worktree: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(worktree, &args)?;
    Ok(())
}

pub fn stage_all(worktree: &Path) -> Result<()> {
    git(worktree, ["add", "-A"])?;
    Ok(())
}

pub fn unstage_all(worktree: &Path) -> Result<()> {
    git(worktree, ["reset", "-q"])?;
    Ok(())
}

/// Throw away unstaged changes. Untracked files are deleted.
/// Throw away unstaged changes in `paths` and delete the new files in `untracked`.
/// Their contents are saved first under `refs/pando/snapshots/discard/`.
/// Returns the snapshot ref holding what was thrown away, for Undo.
pub fn discard(worktree: &Path, paths: &[String], untracked: &[String]) -> Result<Option<String>> {
    let all: Vec<String> = paths.iter().chain(untracked).cloned().collect();
    let snap = if all.is_empty() {
        None
    } else {
        crate::backup::snapshot(&Repo::discover(worktree)?, worktree, "discard", &all)?
    };
    if !paths.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(worktree, &args)?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(untracked.iter().map(String::as_str));
        git(worktree, &args)?;
    }
    Ok(snap)
}

/// Stage (`reverse = false`) or unstage (`reverse = true`) one hunk.
pub fn apply_hunk(worktree: &Path, path: &str, hunk: &Hunk, reverse: bool) -> Result<()> {
    let patch = hunk_patch(path, hunk);
    let mut args = vec!["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"];
    if reverse {
        args.push("--reverse");
    }
    let (code, _, stderr) = git_stdin(worktree, &args, patch.as_bytes())?;
    if code == 0 {
        Ok(())
    } else {
        Err(crate::Error::Git {
            cmd: args.join(" "),
            stderr,
        })
    }
}

/// Stage (`reverse = false`) or unstage (`reverse = true`) only the chosen
/// lines of one hunk. `lines` are indexes into `hunk.lines`.
pub fn apply_lines(
    worktree: &Path,
    path: &str,
    hunk: &Hunk,
    lines: &[usize],
    reverse: bool,
) -> Result<()> {
    if !hunk
        .lines
        .iter()
        .enumerate()
        .any(|(i, l)| lines.contains(&i) && l.kind != crate::diff::LineKind::Context)
    {
        return Err(crate::Error::Msg(
            "Pick at least one added or removed line".into(),
        ));
    }
    apply_hunk(
        worktree,
        path,
        &crate::diff::partial_hunk(hunk, lines, reverse),
        reverse,
    )
}
