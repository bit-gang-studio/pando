//! Structured diffs of one file in a worktree.

use crate::cmd::git;
use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
    /// `\ No newline at end of file` followed this line.
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hunk {
    /// The raw `@@ … @@` line.
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub staged: bool,
    pub binary: bool,
    /// Whole file is new (untracked or added).
    pub new_file: bool,
    pub hunks: Vec<Hunk>,
    pub added: u32,
    pub deleted: u32,
}

/// Diff one path. `staged` compares index to HEAD; otherwise worktree to index.
/// `untracked` files are shown as one all-added hunk.
pub fn file(worktree: &Path, path: &str, staged: bool, untracked: bool) -> Result<FileDiff> {
    if untracked {
        return Ok(untracked_file(worktree, path));
    }
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let out = git(worktree, &args)?;
    let mut d = parse_unified(&out);
    d.path = path.to_string();
    d.staged = staged;
    Ok(d)
}

fn untracked_file(worktree: &Path, path: &str) -> FileDiff {
    let bytes = std::fs::read(worktree.join(path)).unwrap_or_default();
    let binary = bytes.iter().take(8000).any(|b| *b == 0);
    let mut d = FileDiff {
        path: path.to_string(),
        staged: false,
        binary,
        new_file: true,
        hunks: vec![],
        added: 0,
        deleted: 0,
    };
    if binary {
        return d;
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let n = lines.len() as u32;
    if n == 0 {
        return d;
    }
    let hunk_lines = lines
        .iter()
        .enumerate()
        .map(|(i, l)| Line {
            kind: LineKind::Add,
            old_no: None,
            new_no: Some(i as u32 + 1),
            text: l.trim_end_matches('\n').trim_end_matches('\r').to_string(),
            no_newline: !l.ends_with('\n'),
        })
        .collect();
    d.added = n;
    d.hunks.push(Hunk {
        header: format!("@@ -0,0 +1,{n} @@"),
        old_start: 0,
        old_count: 0,
        new_start: 1,
        new_count: n,
        lines: hunk_lines,
    });
    d
}

pub fn parse_unified(out: &str) -> FileDiff {
    let mut d = FileDiff {
        path: String::new(),
        staged: false,
        binary: false,
        new_file: false,
        hunks: vec![],
        added: 0,
        deleted: 0,
    };
    let mut old_no = 0u32;
    let mut new_no = 0u32;
    for raw in out.split_inclusive('\n') {
        let line = raw.trim_end_matches('\n').trim_end_matches('\r');
        if line.starts_with("Binary files") {
            d.binary = true;
            continue;
        }
        if line.starts_with("--- /dev/null") {
            d.new_file = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@ ") {
            let (old_start, old_count, new_start, new_count) = parse_hunk_header(rest);
            old_no = old_start.saturating_sub(1);
            new_no = new_start.saturating_sub(1);
            d.hunks.push(Hunk {
                header: line.to_string(),
                old_start,
                old_count,
                new_start,
                new_count,
                lines: vec![],
            });
            continue;
        }
        let Some(h) = d.hunks.last_mut() else {
            continue;
        };
        if line.starts_with('\\') {
            if let Some(l) = h.lines.last_mut() {
                l.no_newline = true;
            }
            continue;
        }
        let (kind, text) = match line.chars().next() {
            Some('+') => (LineKind::Add, &line[1..]),
            Some('-') => (LineKind::Del, &line[1..]),
            Some(' ') => (LineKind::Context, &line[1..]),
            _ => continue,
        };
        let (o, n) = match kind {
            LineKind::Context => {
                old_no += 1;
                new_no += 1;
                (Some(old_no), Some(new_no))
            }
            LineKind::Add => {
                new_no += 1;
                d.added += 1;
                (None, Some(new_no))
            }
            LineKind::Del => {
                old_no += 1;
                d.deleted += 1;
                (Some(old_no), None)
            }
        };
        h.lines.push(Line {
            kind,
            old_no: o,
            new_no: n,
            text: text.to_string(),
            no_newline: false,
        });
    }
    d
}

/// "-18,7 +18,21 @@ fn foo" -> (18, 7, 18, 21)
fn parse_hunk_header(rest: &str) -> (u32, u32, u32, u32) {
    let mut it = rest.split(' ');
    let range = |s: Option<&str>| -> (u32, u32) {
        let s = s.unwrap_or("0,0").trim_start_matches(['-', '+']);
        let mut p = s.split(',');
        let a = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let b = p.next().and_then(|x| x.parse().ok()).unwrap_or(1);
        (a, b)
    };
    let (os, oc) = range(it.next());
    let (ns, nc) = range(it.next());
    (os, oc, ns, nc)
}

/// Rebuild a patch for one hunk that `git apply` accepts.
pub fn hunk_patch(path: &str, hunk: &Hunk) -> String {
    let mut s = format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{}\n",
        hunk.header
    );
    for l in &hunk.lines {
        let c = match l.kind {
            LineKind::Context => ' ',
            LineKind::Add => '+',
            LineKind::Del => '-',
        };
        s.push(c);
        s.push_str(&l.text);
        s.push('\n');
        if l.no_newline {
            s.push_str("\\ No newline at end of file\n");
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n@@ -1,3 +1,4 @@ fn main\n a\n-b\n+B\n+c\n d\n\\ No newline at end of file\n";

    #[test]
    fn parses_hunks_and_numbers() {
        let d = parse_unified(SAMPLE);
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!(
            (h.old_start, h.old_count, h.new_start, h.new_count),
            (1, 3, 1, 4)
        );
        assert_eq!(h.lines.len(), 5);
        assert_eq!(h.lines[1].kind, LineKind::Del);
        assert_eq!(h.lines[1].old_no, Some(2));
        assert_eq!(h.lines[2].kind, LineKind::Add);
        assert_eq!(h.lines[2].new_no, Some(2));
        assert_eq!(h.lines[4].old_no, Some(3));
        assert_eq!(h.lines[4].new_no, Some(4));
        assert!(h.lines[4].no_newline);
        assert_eq!((d.added, d.deleted), (2, 1));
    }

    #[test]
    fn hunk_patch_round_trips() {
        let d = parse_unified(SAMPLE);
        let p = hunk_patch("x.rs", &d.hunks[0]);
        assert!(p.starts_with("diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1,3 +1,4 @@ fn main\n a\n-b\n+B\n+c\n d\n\\ No newline"));
    }

    #[test]
    fn binary_flag() {
        assert!(parse_unified("Binary files a/x and b/x differ\n").binary);
    }
}
