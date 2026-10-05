//! Clean up a branch's own commits before a pull request: reword, squash, drop.
//!
//! Only a branch's own commits can change: ones on no other remote branch and
//! not on the base. Ones already on its own upstream need a force push after.
//! Reword and squash rebuild commits without touching any files, so they work
//! with uncommitted changes and on a branch with no worktree. Drop changes
//! files, so it's a real rebase in the branch's worktree and can pause on
//! conflicts. A backup of the branch is written first, every time.

use crate::cmd::{git, git_bytes, git_env, git_opt, git_stdin_env};
use crate::error::{Error, Result};
use crate::repo::Repo;
use crate::{backup, operation, worktree};
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

/// The repository's local default branch, when it isn't this one. Its
/// commits aren't this branch's to change, pushed or not.
fn local_base(repo: &Repo, branch: &str) -> Option<String> {
    let b = repo.default_branch.clone().filter(|b| b != branch)?;
    git_opt(
        &repo.common_git_dir,
        ["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")],
    )
    .map(|_| b)
}

/// The branch's own upstream ("refs/remotes/origin/feat/x"). Commits that are
/// only there can still change, followed by a force push. `None` when it has
/// none, or when the upstream is the default branch: that is never rewritten.
fn own_upstream(repo: &Repo, branch: &str) -> Option<String> {
    let full = git_opt(
        &repo.common_git_dir,
        [
            "rev-parse",
            "--symbolic-full-name",
            &format!("{branch}@{{upstream}}"),
        ],
    )?;
    let short = full.strip_prefix("refs/remotes/")?;
    let theirs = short.split_once('/').map(|(_, b)| b)?;
    (repo.default_branch.as_deref() != Some(theirs)).then_some(full)
}

/// `rev-list <tip>` minus what must not change: every remote branch except
/// the branch's own upstream, and the local base.
fn unshared(repo: &Repo, branch: &str, tip: &str) -> Result<Vec<String>> {
    let dir = &repo.common_git_dir;
    let own = own_upstream(repo, branch);
    let mut input = format!("{tip}\n");
    for r in git(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes"])?.lines() {
        if Some(r) != own.as_deref() {
            input.push_str(&format!("^{r}\n"));
        }
    }
    if let Some(b) = local_base(repo, branch) {
        input.push_str(&format!("^refs/heads/{b}\n"));
    }
    // On stdin: a repository can have thousands of remote branches.
    let (code, out, err) = crate::cmd::git_stdin(dir, ["rev-list", "--stdin"], input.as_bytes())?;
    if code != 0 {
        return Err(Error::Git {
            cmd: "rev-list".into(),
            stderr: err,
        });
    }
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .map(str::to_string)
        .collect())
}

/// The commits on `branch` that can be reworded, squashed or dropped, newest
/// first: on no remote branch but its own upstream, and not on the base.
pub fn editable(repo: &Repo, branch: &str) -> Result<Vec<String>> {
    tip(repo, branch)?;
    unshared(repo, branch, &format!("refs/heads/{branch}"))
}

/// The editable commits that are already on the branch's upstream. Changing
/// one means a force push afterwards.
pub fn pushed(repo: &Repo, branch: &str) -> Result<Vec<String>> {
    let Some(own) = own_upstream(repo, branch) else {
        return Ok(vec![]);
    };
    let there: std::collections::HashSet<String> =
        unshared(repo, branch, &own)?.into_iter().collect();
    Ok(editable(repo, branch)?
        .into_iter()
        .filter(|id| there.contains(id))
        .collect())
}

/// Where a commit already lives, for the refusal: "origin/main" or "main".
fn shared_on(repo: &Repo, branch: &str, id: &str) -> String {
    let own = own_upstream(repo, branch);
    let own = own.as_deref().and_then(|o| o.strip_prefix("refs/remotes/"));
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
            .find(|l| !l.ends_with("/HEAD") && Some(*l) != own)
            .map(str::to_string)
    });
    match remote {
        Some(r) => format!("on {r}"),
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
                "{} is {}, which others build on. Pando only changes commits that are yours alone.",
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
    // Changing a pushed commit ends in a force push. That's only safe when
    // the upstream holds nothing this branch hasn't had.
    if let Some(own) = own_upstream(repo, branch) {
        let dir = &repo.common_git_dir;
        let is_in = |id: &str, of: &str| -> Result<bool> {
            Ok(crate::cmd::git_raw(dir, ["merge-base", "--is-ancestor", id, of])?.0 == 0)
        };
        let mut touches_pushed = false;
        for id in ids {
            touches_pushed |= is_in(id, &own)?;
        }
        if touches_pushed
            && !is_in(&own, &old_tip)?
            && !crate::branch::had_before(repo, branch, &own)
        {
            return msg(format!(
                "{} has commits you haven't pulled. Pull first, then change pushed commits.",
                own.trim_start_matches("refs/remotes/")
            ));
        }
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

/// A new commit with `author_of`'s author and date, this tree, these parents.
fn recommit(
    repo: &Repo,
    author_of: &str,
    tree: &str,
    parents: &[String],
    message: &[u8],
) -> Result<String> {
    let who = git(
        &repo.common_git_dir,
        [
            "log",
            "-1",
            "--format=%an%x00%ae%x00%ad",
            "--date=raw",
            author_of,
        ],
    )?;
    let mut who = who.trim_end_matches('\n').split('\0');
    let author = (
        who.next().unwrap_or_default(),
        who.next().unwrap_or_default(),
        who.next().unwrap_or_default(),
    );
    commit_tree(repo, author, tree, parents, message, signs(repo))
}

/// Whether the user signs their commits. Asked once per rewrite.
fn signs(repo: &Repo) -> bool {
    git_opt(&repo.common_git_dir, ["config", "--bool", "commit.gpgsign"]).as_deref() == Some("true")
}

/// `git commit-tree`, with the given author (name, email, date).
fn commit_tree(
    repo: &Repo,
    author: (&str, &str, &str),
    tree: &str,
    parents: &[String],
    message: &[u8],
    sign: bool,
) -> Result<String> {
    let mut args = vec!["commit-tree".to_string(), tree.to_string()];
    for p in parents {
        args.extend(["-p".to_string(), p.clone()]);
    }
    if sign {
        args.push("-S".into());
    }
    let env: [(&str, &OsStr); 3] = [
        ("GIT_AUTHOR_NAME", OsStr::new(author.0)),
        ("GIT_AUTHOR_EMAIL", OsStr::new(author.1)),
        ("GIT_AUTHOR_DATE", OsStr::new(author.2)),
    ];
    let (code, out, err) = git_stdin_env(&repo.common_git_dir, &env, &args, message)?;
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
    // Everything about every commit to rebuild, in one call. Asking git about
    // each commit separately made a reword 300 commits deep take 21 seconds.
    let out = git_bytes(
        &repo.common_git_dir,
        [
            "log",
            "--reverse",
            "--topo-order",
            "--date=raw",
            "--format=%H%x00%P%x00%T%x00%an%x00%ae%x00%ad%x00%B%x00",
            &format!("{from}..{tip}"),
            "--",
        ],
    )?;
    let text = String::from_utf8_lossy(&out);
    let fields: Vec<&str> = text.split('\0').collect();
    let sign = signs(repo);
    for c in fields.chunks(7).filter(|c| c.len() == 7) {
        // Records are joined by a newline, which lands in front of the next id.
        let id = c[0].trim_start_matches('\n');
        let old: Vec<&str> = c[1].split_whitespace().collect();
        let new: Vec<String> = old
            .iter()
            .map(|p| map.get(*p).cloned().unwrap_or_else(|| p.to_string()))
            .collect();
        if new.iter().map(String::as_str).eq(old.iter().copied()) {
            continue;
        }
        let message = format!("{}\n", c[6].trim_end_matches('\n'));
        let made = commit_tree(
            repo,
            (c[3], c[4], c[5]),
            c[2],
            &new,
            message.as_bytes(),
            sign,
        )?;
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
    // One call lists every commit on the way with its parents.
    let listed = git(
        &repo.common_git_dir,
        ["rev-list", "--parents", &newer, &format!("^{older}"), "--"],
    )?;
    let parents_of: HashMap<&str, Vec<&str>> = listed
        .lines()
        .filter_map(|l| {
            let mut ids = l.split_whitespace();
            Some((ids.next()?, ids.collect()))
        })
        .collect();
    let mut run = vec![newer.clone()];
    let mut at = newer.as_str();
    while at != older {
        let p = parents_of.get(at).map(Vec::as_slice).unwrap_or_default();
        if p.len() != 1 {
            return msg(if p.len() > 1 {
                format!(
                    "{} is a merge. Squash only works on a run of plain commits.",
                    short(at)
                )
            } else {
                format!("{} doesn't lead to {}.", short(&older), short(&newer))
            });
        }
        at = p[0];
        run.push(at.to_string());
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
