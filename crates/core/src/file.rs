//! One file over time: the commits that touched it, and who last changed
//! each line.

use crate::cmd::{git_bytes, git_opt};
use crate::error::{Error, Result};
use crate::log::{parse_entry, LogEntry, FORMAT};
use crate::repo::Repo;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// A commit that changed the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileCommit {
    pub entry: LogEntry,
    /// What the file was called in this commit. Differs from today's name
    /// before a rename.
    pub path: String,
    /// git's letter for what happened: A added, M modified, D deleted, R renamed.
    pub change: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileHistory {
    pub commits: Vec<FileCommit>,
    /// More commits exist past `limit`.
    pub truncated: bool,
}

fn msg<T>(m: impl Into<String>) -> Result<T> {
    Err(Error::Msg(m.into()))
}

/// A revision the caller chose: a commit id or a branch name, never an option.
fn check_rev(rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains("..") {
        return msg(format!("{rev} isn't a commit or a branch."));
    }
    Ok(())
}

/// A path inside the repository, as git writes it.
fn check_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || path.split('/').any(|p| p == "..")
    {
        return msg("That isn't a file in this repository.");
    }
    Ok(())
}

/// The commits that changed `path`, newest first, following it through
/// renames. `rev` is where to start from: a commit or branch, or `None` for
/// every branch's history of it... which git can't follow, so `None` means HEAD.
pub fn history(
    repo: &Repo,
    rev: Option<&str>,
    path: &str,
    skip: usize,
    limit: usize,
) -> Result<FileHistory> {
    check_path(path)?;
    let mut args: Vec<String> = vec![
        "log".into(),
        "-z".into(),
        "--follow".into(),
        "--name-status".into(),
        format!("--skip={skip}"),
        format!("--max-count={}", limit + 1),
        // \x01 starts each commit, so its file lines can be told from the next commit.
        format!("--format=%x01{}", FORMAT.trim_start_matches("--format=")),
    ];
    if let Some(r) = rev {
        check_rev(r)?;
        args.push(r.to_string());
    }
    args.push("--".into());
    args.push(path.to_string());
    let out = git_bytes(&repo.root, &args)?;
    let text = String::from_utf8_lossy(&out);
    let mut commits = Vec::new();
    for rec in text.split('\x01').filter(|r| !r.is_empty()) {
        // "<fields>\0\n<status>\0<path>[\0<new path>]\0"
        let Some((head, rest)) = rec.split_once('\0') else {
            continue;
        };
        let Some(entry) = parse_entry(head) else {
            continue;
        };
        let mut f = rest.trim_start_matches('\n').split('\0');
        let change = f.next().unwrap_or_default();
        let first = f.next().unwrap_or_default();
        // A rename or copy lists the old name, then the new one.
        let renamed = change.starts_with('R') || change.starts_with('C');
        let now = if renamed {
            f.next().unwrap_or(first)
        } else {
            first
        };
        commits.push(FileCommit {
            entry,
            path: if now.is_empty() {
                path.to_string()
            } else {
                now.to_string()
            },
            change: change.chars().take(1).collect(),
        });
    }
    let truncated = commits.len() > limit;
    commits.truncate(limit);
    Ok(FileHistory { commits, truncated })
}

/// The commit a line was last changed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlameCommit {
    pub author: String,
    pub time: i64,
    pub summary: String,
    /// The file's name in that commit.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlameLine {
    /// Key into `Blame::commits`. Empty for a line that isn't committed yet.
    pub commit: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blame {
    pub path: String,
    /// One per line of the file, in order.
    pub lines: Vec<BlameLine>,
    /// Every commit named by a line, by id.
    pub commits: BTreeMap<String, BlameCommit>,
}

/// Blame is line by line: past this it's too much to read or to send.
const MAX_BLAME_BYTES: u64 = 2_000_000;

/// Who last changed each line of `path`. With `rev`, the file as of that
/// commit. Without, the working copy in `worktree`: lines not committed yet
/// have an empty commit.
pub fn blame(repo: &Repo, worktree: Option<&Path>, rev: Option<&str>, path: &str) -> Result<Blame> {
    check_path(path)?;
    let dir = worktree.unwrap_or(&repo.root);
    let mut args = vec!["blame".to_string(), "--porcelain".into()];
    let size = match rev {
        Some(r) => {
            check_rev(r)?;
            args.push(r.to_string());
            git_opt(
                &repo.common_git_dir,
                ["cat-file", "-s", &format!("{r}:{path}")],
            )
            .and_then(|s| s.parse::<u64>().ok())
        }
        None => std::fs::metadata(dir.join(path)).ok().map(|m| m.len()),
    };
    let Some(size) = size else {
        return msg(format!("{path} doesn't exist here."));
    };
    if size > MAX_BLAME_BYTES {
        return msg(format!("{path} is too large to blame line by line."));
    }
    args.push("--".into());
    args.push(path.to_string());
    let out = git_bytes(dir, &args)?;
    if out.iter().take(8000).any(|b| *b == 0) {
        return msg(format!("{path} is a binary file."));
    }
    let text = String::from_utf8_lossy(&out);
    let mut lines = Vec::new();
    let mut commits: BTreeMap<String, BlameCommit> = BTreeMap::new();
    let mut current = String::new();
    for l in text.split('\n') {
        if let Some(content) = l.strip_prefix('\t') {
            // All zeros is git's id for "not committed yet".
            let commit = if current.bytes().all(|b| b == b'0') {
                String::new()
            } else {
                current.clone()
            };
            lines.push(BlameLine {
                commit,
                text: content.trim_end_matches('\r').to_string(),
            });
            continue;
        }
        let Some((key, value)) = l.split_once(' ') else {
            continue;
        };
        // A header line: "<id> <line then> <line now> [<lines in group>]".
        if key.len() >= 40 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
            current = key.to_string();
            commits
                .entry(current.clone())
                .or_insert_with(|| BlameCommit {
                    author: String::new(),
                    time: 0,
                    summary: String::new(),
                    path: String::new(),
                });
            continue;
        }
        let Some(c) = commits.get_mut(&current) else {
            continue;
        };
        match key {
            "author" => c.author = value.to_string(),
            "author-time" => c.time = value.parse().unwrap_or(0),
            "summary" => c.summary = value.to_string(),
            "filename" => c.path = value.to_string(),
            _ => {}
        }
    }
    commits.retain(|id, _| !id.bytes().all(|b| b == b'0'));
    Ok(Blame {
        path: path.to_string(),
        lines,
        commits,
    })
}
