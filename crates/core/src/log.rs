//! Commit log with branch and tag labels, for the repo screen.

use crate::cmd::git_bytes;
use crate::error::Result;
use crate::repo::Repo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub summary: String,
    /// Branch names (`main`, `origin/main`) and tags (`tag: v1`) pointing here.
    pub refs: Vec<String>,
    /// HEAD of the main worktree points here.
    pub is_head: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Log {
    pub entries: Vec<LogEntry>,
    /// More commits exist past `limit`.
    pub truncated: bool,
}

/// `branch = None` means every branch and tag.
pub fn list(repo: &Repo, branch: Option<&str>, skip: usize, limit: usize) -> Result<Log> {
    let mut args: Vec<String> = vec![
        "log".into(),
        "-z".into(),
        "--date-order".into(),
        format!("--skip={skip}"),
        format!("--max-count={}", limit + 1),
        FORMAT.into(),
    ];
    match branch {
        Some(b) => args.push(b.to_string()),
        None => args.extend(["--branches".into(), "--remotes".into(), "--tags".into()]),
    }
    let out = git_bytes(&repo.root, &args)?;
    let text = String::from_utf8_lossy(&out);
    let mut entries: Vec<LogEntry> = text
        .split('\0')
        .filter(|e| !e.is_empty())
        .filter_map(parse_entry)
        .collect();
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(Log { entries, truncated })
}

const FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%D";

/// Commits whose message or author contains `query` (any case, taken
/// literally), or whose id starts with it. Newest first. `branch = None`
/// searches every branch and tag. Any case holds for A–Z only: git runs in
/// the C locale here, so "é" doesn't match "É".
pub fn search(
    repo: &Repo,
    branch: Option<&str>,
    query: &str,
    skip: usize,
    limit: usize,
) -> Result<Log> {
    let query = query.trim();
    if query.is_empty() || query.contains(['\n', '\0']) {
        return Ok(Log {
            entries: vec![],
            truncated: false,
        });
    }
    if branch.is_some_and(|b| b.is_empty() || b.starts_with('-')) {
        return Err(crate::Error::Msg("That isn't a branch name.".into()));
    }
    let want = skip + limit + 1;
    let run = |by: String| -> Result<Vec<LogEntry>> {
        let mut args: Vec<String> = vec![
            "log".into(),
            "-z".into(),
            "--date-order".into(),
            format!("--max-count={want}"),
            FORMAT.into(),
            "--regexp-ignore-case".into(),
            "--fixed-strings".into(),
            by,
        ];
        match branch {
            Some(b) => args.push(b.to_string()),
            None => args.extend(["--branches".into(), "--remotes".into(), "--tags".into()]),
        }
        args.push("--".into());
        let out = git_bytes(&repo.root, &args)?;
        Ok(String::from_utf8_lossy(&out)
            .split('\0')
            .filter(|e| !e.is_empty())
            .filter_map(parse_entry)
            .collect())
    };
    // git ANDs --grep with --author, so ask twice and join the answers.
    // Each is a pass over the whole history, so run the two side by side.
    let (by_message, by_author) = std::thread::scope(|s| {
        let m = s.spawn(|| run(format!("--grep={query}")));
        let a = run(format!("--author={query}"));
        (m.join(), a)
    });
    let mut found = by_message.map_err(|_| crate::Error::Msg("Search failed.".into()))??;
    found.extend(by_author?);
    // Newest first. The sort is stable, so commits made in the same second
    // keep git's own order.
    let mut seen = std::collections::HashSet::new();
    found.retain(|f| seen.insert(f.id.clone()));
    found.sort_by_key(|f| std::cmp::Reverse(f.time));
    // A commit id, full or short, goes first.
    if let Some(e) = by_id(repo, branch, query) {
        found.retain(|f| f.id != e.id);
        found.insert(0, e);
    }
    let mut entries: Vec<LogEntry> = found.into_iter().skip(skip).collect();
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(Log { entries, truncated })
}

/// The commit `query` names, if it looks like an id and (with a branch) is on that branch.
fn by_id(repo: &Repo, branch: Option<&str>, query: &str) -> Option<LogEntry> {
    if !(4..=64).contains(&query.len()) || !query.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let dir = &repo.common_git_dir;
    let id = crate::cmd::git_opt(
        dir,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("{query}^{{commit}}"),
        ],
    )?;
    if let Some(b) = branch {
        let on = crate::cmd::git_raw(dir, ["merge-base", "--is-ancestor", &id, b]).ok()?;
        if on.0 != 0 {
            return None;
        }
    }
    let out = git_bytes(&repo.root, ["log", "-1", "-z", FORMAT, &id, "--"]).ok()?;
    String::from_utf8_lossy(&out)
        .split('\0')
        .find(|e| !e.is_empty())
        .and_then(parse_entry)
}

fn parse_entry(e: &str) -> Option<LogEntry> {
    let mut f = e.split('\x1f');
    let id = f.next()?.trim().to_string();
    let parents = f.next()?.split_whitespace().map(str::to_string).collect();
    let author = f.next()?.to_string();
    let time = f.next()?.trim().parse().unwrap_or(0);
    let summary = f.next()?.to_string();
    let deco = f.next().unwrap_or("");
    let mut refs = Vec::new();
    let mut is_head = false;
    for d in deco.split(", ").map(str::trim).filter(|d| !d.is_empty()) {
        if d == "HEAD" {
            is_head = true;
        } else if let Some(name) = d.strip_prefix("HEAD -> ") {
            is_head = true;
            refs.push(name.to_string());
        } else if d.ends_with("/HEAD") {
            continue;
        } else {
            refs.push(d.to_string());
        }
    }
    Some(LogEntry {
        id,
        parents,
        author,
        time,
        summary,
        refs,
        is_head,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decorations() {
        let e = parse_entry("abc\x1fdef 123\x1fChris\x1f1700000000\x1fFix it\x1fHEAD -> main, origin/main, origin/HEAD, tag: v0.1").unwrap();
        assert!(e.is_head);
        assert_eq!(e.refs, vec!["main", "origin/main", "tag: v0.1"]);
        assert_eq!(e.parents, vec!["def", "123"]);
    }
}
