//! A paused git operation in a worktree: rebase, merge, or cherry-pick.

use crate::cmd::{git, git_env, git_raw};
use crate::error::Result;
use crate::{conflict, status};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Rebase,
    Merge,
    CherryPick,
    Revert,
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
    /// Conflicts left in each conflicted file. 0 when there are no markers
    /// (binary, or deleted on one side).
    pub counts: BTreeMap<String, u32>,
    /// Files done during the pause: resolved ones and ones git merged itself.
    pub resolved: Vec<String>,
    /// The part of `resolved` that had conflicts, from git's resolve-undo record.
    pub resolved_by_you: Vec<String>,
}

fn git_path(wt: &Path, name: &str) -> Result<std::path::PathBuf> {
    let p = git(wt, ["rev-parse", "--git-path", name])?;
    let p = p.trim();
    let pb = std::path::PathBuf::from(p);
    Ok(if pb.is_absolute() { pb } else { wt.join(pb) })
}

/// A readable name for a commit: a branch if one points at it, else a short id.
/// Never `remotes/origin/HEAD`.
fn nice_name(wt: &Path, id: &str) -> String {
    let named = git_raw(
        wt,
        [
            "name-rev",
            "--name-only",
            "--no-undefined",
            "--exclude=*/HEAD",
            "--refs=refs/heads/*",
            "--refs=refs/remotes/*",
            id,
        ],
    )
    .ok()
    .filter(|(code, out, _)| *code == 0 && !out.trim().is_empty())
    .map(|(_, out, _)| out.trim().to_string());
    match named {
        Some(n) => {
            let n = n.strip_prefix("remotes/").unwrap_or(&n);
            n.strip_suffix("~0")
                .or(n.strip_suffix("^0"))
                .unwrap_or(n)
                .to_string()
        }
        None => id[..7.min(id.len())].to_string(),
    }
}

/// The name in git's own merge message: "Merge branch 'main' into x".
fn merge_msg_name(msg: &str) -> Option<String> {
    let first = msg.lines().next()?;
    let rest = [
        "Merge branch '",
        "Merge remote-tracking branch '",
        "Merge tag '",
        "Merge commit '",
    ]
    .iter()
    .find_map(|p| first.strip_prefix(p))?;
    Some(rest.split('\'').next()?.to_string())
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
    let revert_head = git_path(wt, "REVERT_HEAD")?;

    let kind = if rebase_merge.is_dir() || rebase_apply.is_dir() {
        OpKind::Rebase
    } else if merge_head.is_file() {
        OpKind::Merge
    } else if cherry_head.is_file() {
        OpKind::CherryPick
    } else if revert_head.is_file() {
        OpKind::Revert
    } else {
        return Ok(None);
    };

    let conflicted: Vec<String> = git(wt, ["diff", "--name-only", "--diff-filter=U"])?
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let counts = conflicted
        .iter()
        .map(|p| (p.clone(), conflict::count(wt, p)))
        .collect();
    // Files that had conflicts and don't now. Keeping a side can leave a
    // file equal to HEAD, so this can't come from what's staged.
    // Records look like "100644 <id> 1\t<path>", one per stage.
    let undo = git(wt, ["ls-files", "--resolve-undo", "-z"])?;
    let resolved_by_you: Vec<String> = undo
        .split('\0')
        .filter_map(|l| l.split_once('\t').map(|(_, p)| p.to_string()))
        .filter(|p| !conflicted.contains(p))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let resolved: Vec<String> = status::files(wt)?
        .into_iter()
        .filter(|f| f.staged.is_some() && !f.conflicted)
        .map(|f| f.path)
        .chain(resolved_by_you.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
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
                .map(|o| nice_name(wt, &o))
                .unwrap_or_else(|| "onto".into());
            let head = read(&dir.join("head-name"))
                .map(|h| h.trim_start_matches("refs/heads/").to_string())
                .unwrap_or_else(|| "branch".into());
            (applied, total, onto, head)
        }
        OpKind::Merge => {
            let head = git_raw(wt, ["branch", "--show-current"])?
                .1
                .trim()
                .to_string();
            let msg = git_path(wt, "MERGE_MSG")?;
            let incoming = std::fs::read_to_string(&msg)
                .ok()
                .and_then(|m| merge_msg_name(&m))
                .or_else(|| {
                    read(&merge_head).and_then(|h| h.lines().next().map(|h| nice_name(wt, h)))
                })
                .unwrap_or_else(|| "merged branch".into());
            (0, 0, head, incoming)
        }
        OpKind::CherryPick | OpKind::Revert => {
            let head = git_raw(wt, ["branch", "--show-current"])?
                .1
                .trim()
                .to_string();
            let f = if kind == OpKind::Revert {
                &revert_head
            } else {
                &cherry_head
            };
            let incoming = read(f)
                .map(|h| h[..7.min(h.len())].to_string())
                .unwrap_or_default();
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
        counts,
        resolved,
        resolved_by_you,
    }))
}

/// Run git with no editor, so continue/commit never waits for one.
fn no_editor(wt: &Path, args: &[&str]) -> Result<String> {
    git_env(wt, &[("GIT_EDITOR", OsStr::new("true"))], args)
}

/// Continue the paused operation. Fails if conflicts remain.
pub fn continue_op(wt: &Path) -> Result<Option<Operation>> {
    let Some(op) = detect(wt)? else {
        return Ok(None);
    };
    if !op.conflicted.is_empty() {
        return Err(crate::Error::Msg(format!(
            "{} file(s) still conflicted",
            op.conflicted.len()
        )));
    }
    let verb = match op.kind {
        OpKind::Rebase => "rebase",
        OpKind::Merge => "merge",
        OpKind::CherryPick => "cherry-pick",
        OpKind::Revert => "revert",
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
        OpKind::Revert => "revert",
    };
    git(wt, [verb, "--abort"])?;
    Ok(())
}
