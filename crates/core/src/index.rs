//! Staging: files, hunks, discard.

use crate::cmd::git;
use crate::diff::{hunk_patch, Hunk};
use crate::error::Result;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

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
pub fn discard(worktree: &Path, paths: &[String], untracked: &[String]) -> Result<()> {
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
    Ok(())
}

/// Stage (`reverse = false`) or unstage (`reverse = true`) one hunk.
pub fn apply_hunk(worktree: &Path, path: &str, hunk: &Hunk, reverse: bool) -> Result<()> {
    let patch = hunk_patch(path, hunk);
    let mut args = vec!["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"];
    if reverse {
        args.push("--reverse");
    }
    let mut child = Command::new("git")
        .current_dir(worktree)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().unwrap().write_all(patch.as_bytes())?;
    let out = child.wait_with_output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(crate::Error::Git {
            cmd: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}
