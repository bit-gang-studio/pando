//! A paused git operation in a worktree: rebase, merge, or cherry-pick.

use crate::cmd::{git, git_raw};
use crate::error::Result;
use crate::status;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Rebase,
    Merge,
    CherryPick,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    pub kind: OpKind,
    /// Commits already replayed (rebase only).
    pub applied: u32,
    /// Total commits to replay (rebase only).
    pub total: u32,
    /// Branch being rebased / merged into. Stage 2 ("ours") side.
    pub head_label: String,
    /// What is being brought in. Stage 3 ("theirs") side.
    pub incoming_label: String,
    pub conflicted: Vec<String>,
    /// Files staged during the pause; usually the ones already resolved.
    pub resolved: Vec<String>,
}

fn git_path(wt: &Path, name: &str) -> Result<std::path::PathBuf> {
    let p = git(wt, ["rev-parse", "--git-path", name])?;
    let p = p.trim();
    let pb = std::path::PathBuf::from(p);
    Ok(if pb.is_absolute() { pb } else { wt.join(pb) })
}

fn read(p: &Path) -> Option<String> {
    std::fs::read_to_string(p)
        .ok()
        .map(|s| s.trim().to_string())
}

/// `None` when nothing is paused.
pub fn detect(wt: &Path) -> Result<Option<Operation>> {
    let rebase_merge = git_path(wt, "rebase-merge")?;
    let rebase_apply = git_path(wt, "rebase-apply")?;
    let merge_head = git_path(wt, "MERGE_HEAD")?;
    let cherry_head = git_path(wt, "CHERRY_PICK_HEAD")?;

    let kind = if rebase_merge.is_dir() || rebase_apply.is_dir() {
        OpKind::Rebase
    } else if merge_head.is_file() {
        OpKind::Merge
    } else if cherry_head.is_file() {
        OpKind::CherryPick
    } else {
        return Ok(None);
    };

    let conflicted: Vec<String> = git(wt, ["diff", "--name-only", "--diff-filter=U"])?
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let resolved: Vec<String> = status::files(wt)?
        .into_iter()
        .filter(|f| f.staged.is_some() && !f.conflicted)
        .map(|f| f.path)
        .collect();

    let (applied, total, head_label, incoming_label) = match kind {
        OpKind::Rebase => {
            let dir = if rebase_merge.is_dir() {
                &rebase_merge
            } else {
                &rebase_apply
            };
            let applied = read(&dir.join("msgnum"))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let total = read(&dir.join("end"))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let onto = read(&dir.join("onto"))
                .map(|o| {
                    git_raw(
                        wt,
                        [
                            "name-rev",
                            "--name-only",
                            "--refs=refs/heads/*",
                            "--refs=refs/remotes/*",
                            &o,
                        ],
                    )
                    .map(|(_, n, _)| n.trim().to_string())
                    .unwrap_or(o)
                })
                .unwrap_or_else(|| "onto".into());
            let head = read(&dir.join("head-name"))
                .map(|h| h.trim_start_matches("refs/heads/").to_string())
                .unwrap_or_else(|| "branch".into());
            (
                applied,
                total,
                onto,
                format!("{head} (commit being replayed)"),
            )
        }
        OpKind::Merge => {
            let head = git_raw(wt, ["branch", "--show-current"])?
                .1
                .trim()
                .to_string();
            let incoming = read(&merge_head)
                .map(|h| {
                    git_raw(wt, ["name-rev", "--name-only", &h])
                        .map(|(_, n, _)| n.trim().to_string())
                        .unwrap_or(h)
                })
                .unwrap_or_else(|| "merged branch".into());
            (0, 0, head, incoming)
        }
        OpKind::CherryPick => {
            let head = git_raw(wt, ["branch", "--show-current"])?
                .1
                .trim()
                .to_string();
            let incoming = read(&cherry_head)
                .map(|h| h[..7.min(h.len())].to_string())
                .unwrap_or_else(|| "cherry-pick".into());
            (0, 0, head, incoming)
        }
    };

    Ok(Some(Operation {
        kind,
        applied,
        total,
        head_label,
        incoming_label,
        conflicted,
        resolved,
    }))
}

fn no_editor(wt: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(wt)
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .args(args)
        .output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(crate::Error::Git {
            cmd: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

/// Continue the paused operation. Fails if conflicts remain.
pub fn continue_op(wt: &Path) -> Result<Option<Operation>> {
    let Some(op) = detect(wt)? else {
        return Ok(None);
    };
    if !op.conflicted.is_empty() {
        return Err(crate::Error::Config(format!(
            "{} file(s) still conflicted",
            op.conflicted.len()
        )));
    }
    let verb = match op.kind {
        OpKind::Rebase => "rebase",
        OpKind::Merge => "merge",
        OpKind::CherryPick => "cherry-pick",
    };
    no_editor(wt, &[verb, "--continue"])?;
    detect(wt)
}

pub fn abort(wt: &Path) -> Result<()> {
    let Some(op) = detect(wt)? else { return Ok(()) };
    let verb = match op.kind {
        OpKind::Rebase => "rebase",
        OpKind::Merge => "merge",
        OpKind::CherryPick => "cherry-pick",
    };
    git(wt, [verb, "--abort"])?;
    Ok(())
}
