//! Linear history and single-commit diffs.

use crate::cmd::{git, git_opt, git_raw, git_stdin};
use crate::commit::{self, CommitInfo};
use crate::error::{gix_err, Result};
use crate::repo::Repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub commits: Vec<CommitInfo>,
    /// Index in `commits` of the merge base with the default branch, if it is in range.
    pub base_index: Option<usize>,
    pub base_branch: Option<String>,
}

/// First-parent history of `rev`, newest first.
pub fn linear(repo: &Repo, rev: &str, limit: usize) -> Result<History> {
    let g = repo.open_gix()?;
    let tip = g.rev_parse_single(rev).map_err(gix_err)?.detach();
    let base_branch = repo.default_branch.clone();
    let base_id = base_branch
        .as_deref()
        .and_then(|b| g.rev_parse_single(b).ok())
        .and_then(|b| g.merge_base(tip, b.detach()).ok())
        .map(|id| id.detach());

    let mut commits = Vec::new();
    let mut base_index = None;
    let walk = g
        .rev_walk([tip])
        .first_parent_only()
        .all()
        .map_err(gix_err)?;
    for c in walk.take(limit) {
        let c = c.map_err(gix_err)?;
        if Some(c.id) == base_id {
            base_index = Some(commits.len());
        }
        commits.push(commit::info(&g, c.id)?);
    }
    Ok(History {
        commits,
        base_index,
        base_branch,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitDiff {
    pub commit: CommitInfo,
    /// Full commit message.
    pub message: String,
    pub files: Vec<FileChange>,
}

pub fn commit_diff(repo: &Repo, id: &str) -> Result<CommitDiff> {
    let g = repo.open_gix()?;
    // Any revision: a full id, a short id, a branch, HEAD.
    let oid = g
        .rev_parse_single(id)
        .map_err(crate::error::gix_err)?
        .detach();
    let info = commit::info(&g, oid)?;
    // -m --first-parent: for merge commits, diff against the first parent
    // instead of git's combined format, which hides most files.
    let stat = git(
        &repo.common_git_dir,
        [
            "show",
            "-m",
            "--first-parent",
            "--format=",
            "--numstat",
            "-z",
            "--no-renames",
            id,
        ],
    )?;
    let files = numstat(&stat);
    let message = git(&repo.common_git_dir, ["log", "-1", "--format=%B", id])?
        .trim_end()
        .to_string();
    Ok(CommitDiff {
        commit: info,
        message,
        files,
    })
}

/// Structured diff of one file in one commit.
pub fn commit_file_diff(repo: &Repo, id: &str, path: &str) -> Result<crate::diff::FileDiff> {
    let out = git(
        &repo.common_git_dir,
        [
            "show",
            "-m",
            "--first-parent",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            id,
            "--",
            path,
        ],
    )?;
    let mut d = crate::diff::parse_unified(&out);
    d.path = path.to_string();
    Ok(d)
}

/// `--numstat -z` output: "added\tdeleted\tpath\0" per file. `-z` keeps
/// paths raw; without it git quotes any non-ASCII name.
fn numstat(out: &str) -> Vec<FileChange> {
    out.split('\0')
        .filter_map(|rec| {
            let mut p = rec.trim_start_matches('\n').splitn(3, '\t');
            let added = p.next()?.parse().unwrap_or(0);
            let deleted = p.next()?.parse().unwrap_or(0);
            let path = p.next()?.to_string();
            (!path.is_empty()).then_some(FileChange {
                path,
                added,
                deleted,
            })
        })
        .collect()
}

/// Everything a branch changes compared with its base, as one diff: what a
/// pull request shows. Diffs from where the branch left the base (`base...head`),
/// so changes made on the base since don't show up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compare {
    pub base: String,
    pub head: String,
    /// Commits on head that aren't on base.
    pub ahead: u32,
    /// Commits on base that aren't on head.
    pub behind: u32,
    /// Where the branch left the base. Everything before it is shared history.
    pub merge_base: Option<String>,
    pub added: u32,
    pub deleted: u32,
    pub files: Vec<FileChange>,
}

pub fn compare(repo: &Repo, base: &str, head: &str) -> Result<Compare> {
    let range = format!("{base}...{head}");
    let counts = git(
        &repo.common_git_dir,
        ["rev-list", "--left-right", "--count", &range],
    )?;
    let mut c = counts.split_whitespace().map(|n| n.parse().unwrap_or(0));
    let (behind, ahead) = (c.next().unwrap_or(0), c.next().unwrap_or(0));
    let stat = git(
        &repo.common_git_dir,
        ["diff", "--numstat", "-z", "--no-renames", &range],
    )?;
    let files = numstat(&stat);
    let merge_base = crate::cmd::git_opt(&repo.common_git_dir, ["merge-base", base, head]);
    Ok(Compare {
        base: base.to_string(),
        head: head.to_string(),
        ahead,
        behind,
        merge_base,
        added: files.iter().map(|f| f.added).sum(),
        deleted: files.iter().map(|f| f.deleted).sum(),
        files,
    })
}

/// One file's diff within `compare`.
pub fn compare_file_diff(
    repo: &Repo,
    base: &str,
    head: &str,
    path: &str,
) -> Result<crate::diff::FileDiff> {
    let out = git(
        &repo.common_git_dir,
        [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            &format!("{base}...{head}"),
            "--",
            path,
        ],
    )?;
    let mut d = crate::diff::parse_unified(&out);
    d.path = path.to_string();
    Ok(d)
}

/// Several commits picked together in the list, as one diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub older: String,
    pub newer: String,
    /// What the diff starts from: the older commit's parent (an empty tree
    /// for the first commit), or the older commit itself when `ancestor` is false.
    pub base: String,
    /// True when the older commit leads to the newer one, so the diff is the
    /// sum of the commits between them. False when they're on different lines
    /// of history: then it's just the difference between the two.
    pub ancestor: bool,
    /// The commits whose changes are added up, newest first (at most 5,000).
    pub commits: Vec<String>,
    pub count: u32,
    pub added: u32,
    pub deleted: u32,
    pub files: Vec<FileChange>,
}

const RANGE_IDS: usize = 5000;

/// The changes from `older` through `newer`, both included. The two may be
/// given in either order when one leads to the other.
pub fn range(repo: &Repo, older: &str, newer: &str) -> Result<Range> {
    let g = repo.open_gix()?;
    let id = |rev: &str| -> Result<String> {
        Ok(g.rev_parse_single(rev)
            .map_err(gix_err)?
            .detach()
            .to_string())
    };
    let (a, b) = (id(older)?, id(newer)?);
    let dir = &repo.common_git_dir;
    let leads_to = |x: &str, y: &str| -> Result<bool> {
        Ok(git_raw(dir, ["merge-base", "--is-ancestor", x, y])?.0 == 0)
    };
    let (older, newer, ancestor) = if leads_to(&a, &b)? {
        (a, b, true)
    } else if leads_to(&b, &a)? {
        (b, a, true)
    } else {
        (a, b, false)
    };
    let (base, ids) = if ancestor {
        let parent = git_opt(
            dir,
            ["rev-parse", "--verify", "--quiet", &format!("{older}^")],
        )
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
        match parent {
            Some(p) => {
                let ids = git(dir, ["rev-list", &format!("{p}..{newer}")])?;
                (p, ids)
            }
            // The first commit has no parent: diff from an empty tree.
            None => {
                let (_, out, _) = git_stdin(dir, ["hash-object", "-t", "tree", "--stdin"], b"")?;
                let empty = String::from_utf8_lossy(&out).trim().to_string();
                (empty, git(dir, ["rev-list", &newer])?)
            }
        }
    } else {
        (older.clone(), format!("{newer}\n{older}\n"))
    };
    let stat = git(
        dir,
        ["diff", "--numstat", "-z", "--no-renames", &base, &newer],
    )?;
    let files = numstat(&stat);
    let count = ids.lines().count() as u32;
    Ok(Range {
        older,
        newer,
        base,
        ancestor,
        commits: ids.lines().take(RANGE_IDS).map(str::to_string).collect(),
        count,
        added: files.iter().map(|f| f.added).sum(),
        deleted: files.iter().map(|f| f.deleted).sum(),
        files,
    })
}

/// One file's diff within `range`. `base` and `newer` are the ids `range` returned.
pub fn range_file_diff(
    repo: &Repo,
    base: &str,
    newer: &str,
    path: &str,
) -> Result<crate::diff::FileDiff> {
    for id in [base, newer] {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(crate::Error::Msg(format!("{id} isn't a commit id.")));
        }
    }
    let out = git(
        &repo.common_git_dir,
        [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            base,
            newer,
            "--",
            path,
        ],
    )?;
    let mut d = crate::diff::parse_unified(&out);
    d.path = path.to_string();
    Ok(d)
}
