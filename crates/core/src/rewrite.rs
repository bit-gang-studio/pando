//! Clean up a branch's own commits before a pull request: reword, squash, drop.
//!
//! Only commits that haven't been pushed and aren't on the base can change.
//! Reword and squash rebuild commits without touching any files, so they work
//! with uncommitted changes and on a branch with no worktree. Drop changes
//! files, so it's a real rebase in the branch's worktree and can pause on
//! conflicts. A backup of the branch is written first, every time.

use crate::cmd::{git, git_bytes, git_env, git_opt, git_stdin_env};
use crate::error::{Error, Result};
use crate::repo::Repo;
use crate::{backup, merge, operation, worktree};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rewritten {
    pub branch: String,
    /// The branch tip before and after. `undo` takes these back.
    pub old_tip: String,
    pub new_tip: String,
    /// A drop stopped on conflicts. Resolve in the worktree, then continue or abort.
    pub paused: bool,
}

fn msg<T>(m: String) -> Result<T> {
    Err(Error::Msg(m))
}

fn short(id: &str) -> &str {
    &id[..7.min(id.len())]
}

/// A full commit id from an id. Ids only: no branch names, no options.
fn commit_id(repo: &Repo, id: &str) -> Result<String> {
    if id.len() < 4 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return msg(format!("{id} isn't a commit id."));
    }
    git_opt(
        &repo.common_git_dir,
        ["rev-parse", "--verify", "-q", &format!("{id}^{{commit}}")],
    )
    .ok_or_else(|| Error::Msg(format!("No commit {id} in this repository.")))
}

fn tip(repo: &Repo, branch: &str) -> Result<String> {
    git_opt(
        &repo.common_git_dir,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
    )
    .ok_or_else(|| Error::Msg(format!("No branch named {branch}.")))
}

/// The repository's base, when it's a local branch other than this one.
/// (A remote base is covered by "anything already pushed".)
fn local_base(repo: &Repo, branch: &str) -> Option<String> {
    merge::compare_base(repo).filter(|b| b != branch && !b.starts_with("origin/"))
}

/// The commits on `branch` that can be reworded, squashed or dropped, newest
/// first: not pushed to any remote, and not on the base.
pub fn editable(repo: &Repo, branch: &str) -> Result<Vec<String>> {
    tip(repo, branch)?;
    let mut args = vec![
        "rev-list".to_string(),
        format!("refs/heads/{branch}"),
        "--not".into(),
        "--remotes".into(),
    ];
    args.extend(local_base(repo, branch).map(|b| format!("refs/heads/{b}")));
    Ok(git(&repo.common_git_dir, &args)?
        .lines()
        .map(str::to_string)
        .collect())
}

/// Where a commit already lives, for the refusal: "origin/feat/x" or "main".
fn shared_on(repo: &Repo, branch: &str, id: &str) -> String {
    let remote = git_opt(
        &repo.common_git_dir,
        [
            "branch",
            "-r",
            "--format=%(refname:short)",
            "--contains",
            id,
        ],
    )
    .and_then(|o| {
        o.lines()
            .find(|l| !l.ends_with("/HEAD"))
            .map(str::to_string)
    });
    match remote {
        Some(r) => format!("already pushed to {r}"),
        None => format!(
            "on {}",
            local_base(repo, branch).unwrap_or_else(|| "the base".into())
        ),
    }
}

/// The worktree that has `branch` checked out, or is in the middle of rebasing it.
fn worktree_of(repo: &Repo, branch: &str) -> Result<(Option<PathBuf>, bool)> {
    let mut found = None;
    for w in worktree::list(repo)? {
        if w.prunable.is_some() || w.bare {
            continue;
        }
        if w.branch.as_deref() == Some(branch) {
            let busy = operation::detect(&w.path)?.is_some();
            return Ok((Some(w.path), busy));
        }
        // A rebase detaches HEAD: the branch isn't "checked out", but it's in use.
        if w.detached {
            if let Some(op) = operation::detect(&w.path)? {
                if op.kind == operation::OpKind::Rebase && op.incoming_label == branch {
                    found = Some(w.path);
                }
            }
        }
    }
    Ok((found.clone(), found.is_some()))
}

struct Target {
    old_tip: String,
    /// Where the branch is checked out, if anywhere.
    wt: Option<PathBuf>,
}

/// Everything that must hold before a branch's commits are rewritten.
fn target(repo: &Repo, branch: &str, ids: &[&str]) -> Result<Target> {
    let old_tip = tip(repo, branch)?;
    let editable = editable(repo, branch)?;
    for id in ids {
        if editable.iter().any(|e| e == id) {
            continue;
        }
        let on_branch = crate::cmd::git_raw(
            &repo.common_git_dir,
            ["merge-base", "--is-ancestor", id, &old_tip],
        )?
        .0 == 0;
        return msg(if on_branch {
            format!(
                "{} is {}. Pando only changes commits that haven't been pushed.",
                short(id),
                shared_on(repo, branch, id)
            )
        } else {
            format!("{} isn't on {branch}.", short(id))
        });
    }
    let (wt, busy) = worktree_of(repo, branch)?;
    if busy {
        return msg(format!(
            "{branch} has a rebase or merge in progress. Continue or abort it first."
        ));
    }
    Ok(Target { old_tip, wt })
}

fn parents(repo: &Repo, id: &str) -> Result<Vec<String>> {
    let line = git(
        &repo.common_git_dir,
        ["rev-list", "--parents", "-n", "1", id],
    )?;
    Ok(line
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect())
}

/// A commit's message, exactly as stored.
fn message(repo: &Repo, id: &str) -> Result<Vec<u8>> {
    let raw = git_bytes(&repo.common_git_dir, ["cat-file", "commit", id])?;
    let at = raw
        .windows(2)
        .position(|w| w == b"\n\n")
        .map(|i| i + 2)
        .unwrap_or(raw.len());
    Ok(raw[at..].to_vec())
}

/// A new commit with `author_of`'s author and date, this tree, these parents.
fn recommit(
    repo: &Repo,
    author_of: &str,
    tree: &str,
    parents: &[String],
    message: &[u8],
) -> Result<String> {
    let dir = &repo.common_git_dir;
    let who = git(
        dir,
        [
            "log",
            "-1",
            "--format=%an%x00%ae%x00%ad",
            "--date=raw",
            author_of,
        ],
    )?;
    let mut who = who.trim_end_matches('\n').split('\0');
    let (name, email, date) = (
        who.next().unwrap_or_default(),
        who.next().unwrap_or_default(),
        who.next().unwrap_or_default(),
    );
    let mut args = vec!["commit-tree".to_string(), tree.to_string()];
    for p in parents {
        args.extend(["-p".to_string(), p.clone()]);
    }
    if git_opt(dir, ["config", "--bool", "commit.gpgsign"]).as_deref() == Some("true") {
        args.push("-S".into());
    }
    let env: [(&str, &OsStr); 3] = [
        ("GIT_AUTHOR_NAME", OsStr::new(name)),
        ("GIT_AUTHOR_EMAIL", OsStr::new(email)),
        ("GIT_AUTHOR_DATE", OsStr::new(date)),
    ];
    let (code, out, err) = git_stdin_env(dir, &env, &args, message)?;
    if code != 0 {
        return Err(Error::Git {
            cmd: "commit-tree".into(),
            stderr: err,
        });
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

fn tree(repo: &Repo, id: &str) -> Result<String> {
    Ok(git(
        &repo.common_git_dir,
        ["rev-parse", &format!("{id}^{{tree}}")],
    )?
    .trim()
    .to_string())
}

/// Rebuild every commit after `from` up to `tip` on top of `from`'s
/// replacement. Trees and messages stay exactly as they were; merges keep
/// all their parents. Returns the new tip.
fn replay(repo: &Repo, from: &str, replacement: &str, tip: &str) -> Result<String> {
    let mut map: HashMap<String, String> = HashMap::new();
    map.insert(from.to_string(), replacement.to_string());
    let list = git(
        &repo.common_git_dir,
        [
            "rev-list",
            "--reverse",
            "--topo-order",
            "--parents",
            &format!("{from}..{tip}"),
        ],
    )?;
    for line in list.lines() {
        let mut ids = line.split_whitespace();
        let Some(id) = ids.next() else { continue };
        let old: Vec<&str> = ids.collect();
        let new: Vec<String> = old
            .iter()
            .map(|p| map.get(*p).cloned().unwrap_or_else(|| p.to_string()))
            .collect();
        if new.iter().map(String::as_str).eq(old.iter().copied()) {
            continue;
        }
        let made = recommit(repo, id, &tree(repo, id)?, &new, &message(repo, id)?)?;
        map.insert(id.to_string(), made);
    }
    Ok(map.get(tip).cloned().unwrap_or_else(|| tip.to_string()))
}

/// Point the branch at `new`, if it still points at `old`. The files of both
/// are the same, so a worktree that has it checked out sees no change.
fn move_branch(
    repo: &Repo,
    branch: &str,
    t: &Target,
    new: String,
    what: &str,
) -> Result<Rewritten> {
    backup::write(repo, branch)?;
    git(
        &repo.common_git_dir,
        [
            "update-ref",
            "-m",
            &format!("pando: {what}"),
            &format!("refs/heads/{branch}"),
            &new,
            &t.old_tip,
        ],
    )?;
    Ok(Rewritten {
        branch: branch.to_string(),
        old_tip: t.old_tip.clone(),
        new_tip: new,
        paused: false,
    })
}

fn clean_message(message: &str) -> Result<Vec<u8>> {
    let m = message.trim();
    if m.is_empty() {
        return msg("A commit needs a message.".into());
    }
    Ok(format!("{m}\n").into_bytes())
}

/// Change one commit's message.
pub fn reword(repo: &Repo, branch: &str, id: &str, message: &str) -> Result<Rewritten> {
    let text = clean_message(message)?;
    let id = commit_id(repo, id)?;
    let t = target(repo, branch, &[&id])?;
    let made = recommit(repo, &id, &tree(repo, &id)?, &parents(repo, &id)?, &text)?;
    let new = replay(repo, &id, &made, &t.old_tip)?;
    move_branch(repo, branch, &t, new, "reword")
}

/// Make one commit out of `older` through `newer`, a run with no merges in it.
/// It keeps the oldest commit's author and date.
pub fn squash(
    repo: &Repo,
    branch: &str,
    older: &str,
    newer: &str,
    message: &str,
) -> Result<Rewritten> {
    let text = clean_message(message)?;
    let (older, newer) = (commit_id(repo, older)?, commit_id(repo, newer)?);
    if older == newer {
        return msg("Pick at least two commits to squash.".into());
    }
    // Walk down from the newer commit: one parent each, until the older one.
    let mut run = vec![newer.clone()];
    let mut at = newer.clone();
    while at != older {
        let p = parents(repo, &at)?;
        if p.len() != 1 || run.len() > 5000 {
            return msg(if p.len() > 1 {
                format!(
                    "{} is a merge. Squash only works on a run of plain commits.",
                    short(&at)
                )
            } else {
                format!("{} doesn't lead to {}.", short(&older), short(&newer))
            });
        }
        at = p[0].clone();
        run.push(at.clone());
    }
    let base = parents(repo, &older)?;
    if base.len() > 1 {
        return msg(format!(
            "{} is a merge. Squash only works on a run of plain commits.",
            short(&older)
        ));
    }
    let refs: Vec<&str> = run.iter().map(String::as_str).collect();
    let t = target(repo, branch, &refs)?;
    let made = recommit(repo, &older, &tree(repo, &newer)?, &base, &text)?;
    let new = replay(repo, &newer, &made, &t.old_tip)?;
    move_branch(repo, branch, &t, new, "squash")
}

/// Remove one commit and its changes. Runs `git rebase` in the branch's
/// worktree. On conflicts the rebase stays paused there.
pub fn drop(repo: &Repo, branch: &str, id: &str) -> Result<Rewritten> {
    let id = commit_id(repo, id)?;
    let t = target(repo, branch, &[&id])?;
    let p = parents(repo, &id)?;
    if p.len() != 1 {
        return msg(if p.is_empty() {
            format!("{} is the first commit. It can't be dropped.", short(&id))
        } else {
            format!("{} is a merge. It can't be dropped.", short(&id))
        });
    }
    let Some(wt) = t.wt.clone() else {
        return msg(format!(
            "Dropping a commit changes files. Add a worktree for {branch} first."
        ));
    };
    let dirty = git(&wt, ["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.trim().is_empty() {
        return msg("Commit or stash your changes before dropping a commit.".into());
    }
    backup::write(repo, branch)?;
    let done = |paused: bool| -> Result<Rewritten> {
        Ok(Rewritten {
            branch: branch.to_string(),
            old_tip: t.old_tip.clone(),
            new_tip: if paused {
                t.old_tip.clone()
            } else {
                tip(repo, branch)?
            },
            paused,
        })
    };
    let run = git_env(
        &wt,
        &[("GIT_EDITOR", OsStr::new("true"))],
        ["rebase", "--rebase-merges", "--onto", &p[0], &id],
    );
    match run {
        Ok(_) => done(false),
        Err(e) => {
            let conflicts = git(&wt, ["diff", "--name-only", "--diff-filter=U"])
                .map(|o| !o.trim().is_empty())
                .unwrap_or(false);
            if conflicts {
                return done(true);
            }
            let _ = git(&wt, ["rebase", "--abort"]);
            Err(e)
        }
    }
}

/// Take a rewrite back: the branch returns to `to`, if it is still at `from`.
pub fn undo(repo: &Repo, branch: &str, from: &str, to: &str) -> Result<()> {
    let (from, to) = (commit_id(repo, from)?, commit_id(repo, to)?);
    let now = tip(repo, branch)?;
    if now != from {
        return msg(format!("{branch} has changed since. Nothing was undone."));
    }
    let (wt, busy) = worktree_of(repo, branch)?;
    if busy {
        return msg(format!(
            "{branch} has a rebase or merge in progress. Continue or abort it first."
        ));
    }
    backup::write(repo, branch)?;
    match wt {
        // A drop changed files: put them back too. Keeps uncommitted changes,
        // and refuses if they'd be overwritten.
        Some(w) if tree(repo, &from)? != tree(repo, &to)? => {
            git(&w, ["reset", "--keep", &to])?;
        }
        // Same files either way: just move the branch. The index isn't touched,
        // so what's staged stays staged.
        _ => {
            git(
                &repo.common_git_dir,
                [
                    "update-ref",
                    "-m",
                    "pando: undo",
                    &format!("refs/heads/{branch}"),
                    &to,
                    &from,
                ],
            )?;
        }
    }
    Ok(())
}
