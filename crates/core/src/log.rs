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
        "--format=%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%D".into(),
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
