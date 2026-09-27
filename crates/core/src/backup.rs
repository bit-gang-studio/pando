//! Safety nets. Written before any change that could lose work.
//!
//! - Branch backups: `refs/pando/backup/<branch>`, the tip before a change.
//!   Each write is kept in that ref's reflog, so older backups survive too.
//! - Snapshots: `refs/pando/snapshots/<what>/<time>`, a commit holding the
//!   files a discard, forced worktree removal or stash drop is about to lose.
//!
//! Neither is ever pushed. Nothing here changes files on disk.

use crate::cmd::{git, git_env, git_opt};
use crate::error::Result;
use crate::repo::Repo;
use std::ffi::OsStr;
use std::path::Path;

pub const PREFIX: &str = "refs/pando/backup/";
pub const SNAPSHOTS: &str = "refs/pando/snapshots/";

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
        [
            "update-ref",
            "--create-reflog",
            "-m",
            "pando backup",
            &name,
            &head,
        ],
    )?;
    Ok(Some(name))
}

/// Save the current contents of `paths` in `worktree` (tracked or new files;
/// empty means every change) as a commit on top of HEAD, under
/// `refs/pando/snapshots/<what>/<time>`. Returns the ref, or `None` if there
/// was nothing to save.
pub fn snapshot(
    repo: &Repo,
    worktree: &Path,
    what: &str,
    paths: &[String],
) -> Result<Option<String>> {
    let index = repo
        .common_git_dir
        .join(format!("pando-snapshot-{}.index", std::process::id()));
    let env: [(&str, &OsStr); 5] = [
        ("GIT_INDEX_FILE", index.as_os_str()),
        ("GIT_AUTHOR_NAME", OsStr::new("Pando")),
        ("GIT_AUTHOR_EMAIL", OsStr::new("pando@localhost")),
        ("GIT_COMMITTER_NAME", OsStr::new("Pando")),
        ("GIT_COMMITTER_EMAIL", OsStr::new("pando@localhost")),
    ];
    let head = git_opt(worktree, ["rev-parse", "--verify", "-q", "HEAD"]);
    let result = (|| {
        match &head {
            Some(h) => git_env(worktree, &env, ["read-tree", h.as_str()])?,
            None => git_env(worktree, &env, ["read-tree", "--empty"])?,
        };
        let mut add = vec!["add", "-A", "--"];
        if paths.is_empty() {
            add.push(".");
        } else {
            add.extend(paths.iter().map(String::as_str));
        }
        git_env(worktree, &env, &add)?;
        let tree = git_env(worktree, &env, ["write-tree"])?.trim().to_string();
        if let Some(h) = &head {
            let head_tree = git(worktree, ["rev-parse", &format!("{h}^{{tree}}")])?;
            if head_tree.trim() == tree {
                return Ok(None);
            }
        }
        let mut commit = vec!["commit-tree", tree.as_str(), "-m", "pando snapshot"];
        if let Some(h) = &head {
            commit.extend(["-p", h.as_str()]);
        }
        let id = git_env(worktree, &env, &commit)?.trim().to_string();
        let name = format!("{SNAPSHOTS}{what}/{}", stamp());
        git(worktree, ["update-ref", &name, &id])?;
        Ok(Some(name))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Keep a dropped stash reachable at `refs/pando/snapshots/stash/<time>`.
pub fn keep_commit(repo: &Repo, what: &str, id: &str) -> Result<String> {
    let name = format!("{SNAPSHOTS}{what}/{}", stamp());
    git(&repo.common_git_dir, ["update-ref", &name, id])?;
    Ok(name)
}

/// Sortable and unique enough: nanoseconds since the epoch.
fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// What a backup holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A branch tip from before a change moved or deleted it.
    Branch,
    /// Files thrown away by Discard.
    Discard,
    /// Uncommitted changes in a worktree removed with force.
    RemoveWorktree,
    /// Changes a restore was about to overwrite.
    Restore,
    /// A dropped stash.
    Stash,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Backup {
    pub refname: String,
    pub kind: Kind,
    /// The branch, for branch backups.
    pub branch: Option<String>,
    pub id: String,
    /// When it was saved (unix seconds).
    pub time: i64,
    /// Files it holds, for snapshots and stashes.
    pub files: Vec<String>,
    /// For branch backups: whether the branch exists now.
    pub branch_exists: bool,
}

/// Every backup worth offering, newest first. Branch backups that match the
/// branch as it is now are left out: there's nothing to restore.
pub fn list(repo: &Repo) -> Result<Vec<Backup>> {
    let out = git(
        &repo.common_git_dir,
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(creatordate:unix)",
            "refs/pando/",
        ],
    )?;
    let mut all = Vec::new();
    for line in out.lines() {
        let mut f = line.split('\0');
        let (Some(refname), Some(id), Some(date)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let (refname, id) = (refname.to_string(), id.to_string());
        let commit_time: i64 = date.parse().unwrap_or(0);
        if let Some(branch) = refname.strip_prefix(PREFIX) {
            let now = git_opt(
                &repo.common_git_dir,
                [
                    "rev-parse",
                    "--verify",
                    "-q",
                    &format!("refs/heads/{branch}"),
                ],
            );
            if now.as_deref() == Some(id.as_str()) {
                continue;
            }
            all.push(Backup {
                time: reflog_time(repo, &refname).unwrap_or(commit_time),
                kind: Kind::Branch,
                branch: Some(branch.to_string()),
                branch_exists: now.is_some(),
                files: vec![],
                refname,
                id,
            });
        } else if let Some(rest) = refname.strip_prefix(SNAPSHOTS) {
            let (what, stamp) = rest.rsplit_once('/').unwrap_or((rest, "0"));
            let kind = match what {
                "discard" => Kind::Discard,
                "remove-worktree" => Kind::RemoveWorktree,
                "restore" => Kind::Restore,
                "stash" => Kind::Stash,
                _ => continue,
            };
            let time = stamp
                .parse::<u128>()
                .map(|n| (n / 1_000_000_000) as i64)
                .unwrap_or(commit_time);
            all.push(Backup {
                files: snapshot_files(repo, kind, &id).unwrap_or_default(),
                kind,
                branch: None,
                branch_exists: false,
                time,
                refname,
                id,
            });
        }
    }
    all.sort_by_key(|a| std::cmp::Reverse(a.time));
    Ok(all)
}

/// Newest reflog entry's time: when the backup was written.
fn reflog_time(repo: &Repo, refname: &str) -> Option<i64> {
    let log = std::fs::read_to_string(repo.common_git_dir.join("logs").join(refname)).ok()?;
    let last = log.lines().last()?;
    let before_tab = last.split('\t').next()?;
    let mut parts = before_tab.rsplitn(3, ' ');
    let _tz = parts.next()?;
    parts.next()?.parse().ok()
}

fn snapshot_files(repo: &Repo, kind: Kind, id: &str) -> Result<Vec<String>> {
    let out = if kind == Kind::Stash {
        // `stash show` needs a worktree, so run it in the main one.
        git(
            &repo.root,
            [
                "stash",
                "show",
                "--include-untracked",
                "--name-only",
                "-z",
                id,
            ],
        )?
    } else {
        // A snapshot with no parent was taken in a repo with no commits.
        let has_parent = git_opt(
            &repo.common_git_dir,
            ["rev-parse", "-q", "--verify", &format!("{id}^")],
        )
        .is_some();
        let mut args = vec!["diff-tree", "--no-commit-id", "--name-only", "-r", "-z"];
        if !has_parent {
            args.push("--root");
        }
        args.push(id);
        git(&repo.common_git_dir, &args)?
    };
    Ok(out
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

fn only_ours(refname: &str) -> Result<()> {
    if refname.starts_with(PREFIX) || refname.starts_with(SNAPSHOTS) {
        Ok(())
    } else {
        Err(crate::Error::Msg(format!("{refname} isn't a Pando backup")))
    }
}

/// Point the branch back at its backup, creating it if it was deleted. The
/// branch's current tip is backed up first, so this can be undone the same way.
pub fn restore_branch(repo: &Repo, refname: &str) -> Result<()> {
    only_ours(refname)?;
    let branch = refname
        .strip_prefix(PREFIX)
        .ok_or_else(|| crate::Error::Msg("Not a branch backup".into()))?;
    if let Some(w) = crate::worktree::list(repo)?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(branch))
    {
        return Err(crate::Error::Msg(format!(
            "{branch} is checked out in {}. Switch that worktree to another branch first.",
            w.path.display()
        )));
    }
    let id = git(&repo.common_git_dir, ["rev-parse", refname])?
        .trim()
        .to_string();
    write(repo, branch)?;
    git(&repo.root, ["branch", "-f", branch, &id])?;
    Ok(())
}

/// Put a snapshot's files back into `worktree`, or apply a dropped stash there.
/// Whatever those files hold now is snapshotted first.
pub fn restore_files(repo: &Repo, refname: &str, worktree: &Path) -> Result<()> {
    only_ours(refname)?;
    let b = list(repo)?
        .into_iter()
        .find(|b| b.refname == refname)
        .ok_or_else(|| crate::Error::Msg("That backup no longer exists".into()))?;
    if b.kind == Kind::Stash {
        git(worktree, ["stash", "apply", &b.id])?;
        return Ok(());
    }
    if b.kind == Kind::Branch {
        return Err(crate::Error::Msg(
            "Use Restore branch for a branch backup".into(),
        ));
    }
    let in_snapshot: Vec<String> = git(
        worktree,
        ["ls-tree", "-r", "--name-only", "-z", &b.id, "--"],
    )?
    .split('\0')
    .filter(|s| !s.is_empty())
    .map(str::to_string)
    .collect();
    let (keep, gone): (Vec<String>, Vec<String>) =
        b.files.into_iter().partition(|f| in_snapshot.contains(f));
    let existing: Vec<String> = keep
        .iter()
        .chain(&gone)
        .filter(|f| worktree.join(f).exists())
        .cloned()
        .collect();
    if !existing.is_empty() {
        snapshot(repo, worktree, "restore", &existing)?;
    }
    if !keep.is_empty() {
        let mut args = vec!["restore", "--source", b.id.as_str(), "--worktree", "--"];
        args.extend(keep.iter().map(String::as_str));
        git(worktree, &args)?;
    }
    for f in &gone {
        let _ = std::fs::remove_file(worktree.join(f));
    }
    Ok(())
}

/// Delete a backup for good.
pub fn delete(repo: &Repo, refname: &str) -> Result<()> {
    only_ours(refname)?;
    git(&repo.common_git_dir, ["update-ref", "-d", refname])?;
    Ok(())
}
