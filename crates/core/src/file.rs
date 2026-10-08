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

/// A file or folder in one folder of the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    /// From the top of the repository, with `/` between parts.
    pub path: String,
    pub dir: bool,
}

/// One folder is listed at a time, so a huge repository costs no more than
/// the folders you open. Past this many entries the rest are left out.
const MAX_ENTRIES: usize = 5000;

/// What's in `dir` ("" for the top). With `rev`, as of that commit. Without,
/// what's on disk in `worktree`: tracked and new files, not ignored ones.
/// Folders first, then by name.
pub fn list(
    repo: &Repo,
    worktree: Option<&Path>,
    rev: Option<&str>,
    dir: &str,
) -> Result<Vec<Entry>> {
    if !dir.is_empty() {
        check_path(dir)?;
    }
    let dir = dir.trim_end_matches('/');
    let under = |name: &str| {
        if dir.is_empty() {
            name.to_string()
        } else {
            format!("{dir}/{name}")
        }
    };
    let mut out: Vec<Entry> = Vec::new();
    match rev {
        Some(r) => {
            check_rev(r)?;
            let tree = format!("{r}:{dir}");
            let bytes = git_bytes(&repo.common_git_dir, ["ls-tree", "-z", &tree])
                .map_err(|_| Error::Msg(format!("{} doesn't exist at {r}.", shown(dir))))?;
            for item in String::from_utf8_lossy(&bytes).split('\0') {
                // "<mode> <type> <id>\t<name>"
                let Some((meta, name)) = item.split_once('\t') else {
                    continue;
                };
                out.push(Entry {
                    name: name.to_string(),
                    path: under(name),
                    dir: meta.split(' ').nth(1) == Some("tree"),
                });
            }
        }
        None => {
            let top = worktree.unwrap_or(&repo.root);
            let read = std::fs::read_dir(top.join(dir))
                .map_err(|_| Error::Msg(format!("{} doesn't exist here.", shown(dir))))?;
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                // Git's own folder (a file, in a linked worktree) isn't part of the tree.
                if dir.is_empty() && name == ".git" {
                    continue;
                }
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                out.push(Entry {
                    path: under(&name),
                    name,
                    dir: is_dir,
                });
            }
            let ignored = ignored(top, &out);
            out.retain(|e| !ignored.contains(&e.path));
        }
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    out.truncate(MAX_ENTRIES);
    Ok(out)
}

fn shown(dir: &str) -> &str {
    if dir.is_empty() {
        "That folder"
    } else {
        dir
    }
}

/// Which of `entries` git ignores. If git can't say, nothing is hidden.
fn ignored(top: &Path, entries: &[Entry]) -> std::collections::HashSet<String> {
    if entries.is_empty() {
        return Default::default();
    }
    let input = entries
        .iter()
        .map(|e| e.path.as_str())
        .collect::<Vec<_>>()
        .join("\0");
    match crate::cmd::git_stdin(top, ["check-ignore", "-z", "--stdin"], input.as_bytes()) {
        Ok((_, out, _)) => String::from_utf8_lossy(&out)
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect(),
        Err(_) => Default::default(),
    }
}

/// A file's contents, or why they aren't shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contents {
    pub path: String,
    pub size: u64,
    /// Missing for a binary file, a link, or one too large to show.
    pub text: Option<String>,
    /// Why there's no text, in plain words.
    pub why: Option<String>,
}

/// Past this a file is too much to read on a screen, or to send to it.
const MAX_READ_BYTES: u64 = 1_000_000;

/// `path` as of `rev`, or as it is on disk in `worktree`.
pub fn read(
    repo: &Repo,
    worktree: Option<&Path>,
    rev: Option<&str>,
    path: &str,
) -> Result<Contents> {
    check_path(path)?;
    let none = |size: u64, why: String| {
        Ok(Contents {
            path: path.to_string(),
            size,
            text: None,
            why: Some(why),
        })
    };
    let bytes = match rev {
        Some(r) => {
            check_rev(r)?;
            let at = format!("{r}:{path}");
            let Some(size) = git_opt(&repo.common_git_dir, ["cat-file", "-s", &at])
                .and_then(|s| s.parse::<u64>().ok())
            else {
                return msg(format!("{path} doesn't exist at {r}."));
            };
            if size > MAX_READ_BYTES {
                return none(size, "This file is too large to show.".into());
            }
            git_bytes(&repo.common_git_dir, ["cat-file", "blob", &at])
                .map_err(|_| Error::Msg(format!("{path} isn't a file.")))?
        }
        None => {
            let full = worktree.unwrap_or(&repo.root).join(path);
            let Ok(meta) = std::fs::symlink_metadata(&full) else {
                return msg(format!("{path} doesn't exist here."));
            };
            // Never followed: a link can point anywhere on the disk.
            if meta.file_type().is_symlink() {
                let to = std::fs::read_link(&full)
                    .map(|t| t.to_string_lossy().into_owned())
                    .unwrap_or_default();
                return none(0, format!("A link to {to}."));
            }
            if !meta.is_file() {
                return msg(format!("{path} isn't a file."));
            }
            if meta.len() > MAX_READ_BYTES {
                return none(meta.len(), "This file is too large to show.".into());
            }
            std::fs::read(&full).map_err(|e| Error::Msg(format!("Couldn't read {path}: {e}")))?
        }
    };
    let size = bytes.len() as u64;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return none(size, "This is a binary file.".into());
    }
    Ok(Contents {
        path: path.to_string(),
        size,
        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        why: None,
    })
}

/// Files found by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Found {
    pub paths: Vec<String>,
    /// There were more than the limit.
    pub truncated: bool,
}

/// Files whose path has every word of `query`, in any case. A match in the
/// file's own name comes before a match in a folder's.
pub fn find(
    repo: &Repo,
    worktree: Option<&Path>,
    rev: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Found> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(Found {
            paths: Vec::new(),
            truncated: false,
        });
    }
    let bytes = match rev {
        Some(r) => {
            check_rev(r)?;
            git_bytes(
                &repo.common_git_dir,
                ["ls-tree", "-r", "-z", "--name-only", r],
            )?
        }
        None => git_bytes(
            worktree.unwrap_or(&repo.root),
            [
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        )?,
    };
    let all = String::from_utf8_lossy(&bytes);
    let (mut by_name, mut by_folder) = (Vec::new(), Vec::new());
    for p in all.split('\0').filter(|p| !p.is_empty()) {
        let low = p.to_lowercase();
        if !words.iter().all(|w| low.contains(w.as_str())) {
            continue;
        }
        let name = low.rsplit('/').next().unwrap_or(&low);
        if words.iter().all(|w| name.contains(w.as_str())) {
            by_name.push(p.to_string());
        } else {
            by_folder.push(p.to_string());
        }
    }
    by_name.sort();
    by_name.dedup();
    by_folder.sort();
    by_folder.dedup();
    by_name.append(&mut by_folder);
    let truncated = by_name.len() > limit;
    by_name.truncate(limit);
    Ok(Found {
        paths: by_name,
        truncated,
    })
}
