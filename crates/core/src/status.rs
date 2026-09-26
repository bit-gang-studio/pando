//! Working tree summary from `git status --porcelain=v2 -z`.

use crate::cmd::git_bytes;
use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Summary {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

impl Summary {
    pub fn changed(&self) -> u32 {
        self.staged + self.unstaged + self.untracked + self.conflicts
    }
    pub fn is_clean(&self) -> bool {
        self.changed() == 0
    }
}

/// One entry from `git status`. `staged`/`unstaged` are the porcelain XY codes
/// (`M`, `A`, `D`, `R`, …) or `None` when that side is unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    /// Old path for renames.
    pub orig_path: Option<String>,
    pub staged: Option<char>,
    pub unstaged: Option<char>,
    pub untracked: bool,
    pub conflicted: bool,
}

pub fn files(worktree: &Path) -> Result<Vec<FileStatus>> {
    let out = git_bytes(
        worktree,
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_files(&out))
}

fn parse_files(out: &[u8]) -> Vec<FileStatus> {
    let text = String::from_utf8_lossy(out);
    let mut files = Vec::new();
    let mut entries = text.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        let kind = e.chars().next().unwrap_or(' ');
        match kind {
            '1' | '2' => {
                // 1 XY sub mH mI mW hH hI path
                // 2 XY sub mH mI mW hH hI Xscore path<NUL>orig
                let fields: Vec<&str> = e.splitn(if kind == '1' { 9 } else { 10 }, ' ').collect();
                let xy = fields.get(1).copied().unwrap_or("..");
                let path = fields.last().copied().unwrap_or("").to_string();
                let orig_path = if kind == '2' {
                    entries.next().map(str::to_string)
                } else {
                    None
                };
                let mut c = xy.chars();
                let x = c.next().filter(|c| *c != '.');
                let y = c.next().filter(|c| *c != '.');
                files.push(FileStatus {
                    path,
                    orig_path,
                    staged: x,
                    unstaged: y,
                    untracked: false,
                    conflicted: false,
                });
            }
            'u' => {
                let path = e.rsplit(' ').next().unwrap_or("").to_string();
                files.push(FileStatus {
                    path,
                    orig_path: None,
                    staged: None,
                    unstaged: Some('U'),
                    untracked: false,
                    conflicted: true,
                });
            }
            '?' => {
                let path = e[2..].to_string();
                files.push(FileStatus {
                    path,
                    orig_path: None,
                    staged: None,
                    unstaged: None,
                    untracked: true,
                    conflicted: false,
                });
            }
            _ => {}
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

pub fn summary(worktree: &Path) -> Result<Summary> {
    let out = git_bytes(
        worktree,
        ["status", "--porcelain=v2", "-z", "--untracked-files=normal"],
    )?;
    Ok(parse(&out))
}

fn parse(out: &[u8]) -> Summary {
    let text = String::from_utf8_lossy(out);
    let mut s = Summary::default();
    let mut entries = text.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        let mut f = e.splitn(3, ' ');
        let kind = f.next().unwrap_or("");
        let xy = f.next().unwrap_or("..");
        match kind {
            "1" | "2" => {
                let mut c = xy.chars();
                if c.next() != Some('.') {
                    s.staged += 1;
                }
                if c.next() != Some('.') {
                    s.unstaged += 1;
                }
                if kind == "2" {
                    entries.next(); // rename: original path follows
                }
            }
            "u" => s.conflicts += 1,
            "?" => s.untracked += 1,
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_each_kind() {
        let raw = "1 .M N... 100644 100644 100644 a a src/a.rs\0\
                   1 M. N... 100644 100644 100644 b b src/b.rs\0\
                   1 MM N... 100644 100644 100644 c c src/c.rs\0\
                   2 R. N... 100644 100644 100644 d d R100 new.rs\0old.rs\0\
                   u UU N... 100644 100644 100644 100644 e e e src/e.rs\0\
                   ? notes.txt\0";
        let s = parse(raw.as_bytes());
        assert_eq!(s.staged, 3);
        assert_eq!(s.unstaged, 2);
        assert_eq!(s.untracked, 1);
        assert_eq!(s.conflicts, 1);
        assert_eq!(s.changed(), 7);
    }

    #[test]
    fn files_parse_kinds_and_renames() {
        let raw = "1 .M N... 100644 100644 100644 a a src/a.rs\0\
                   2 R. N... 100644 100644 100644 d d R100 new.rs\0old.rs\0\
                   u UU N... 100644 100644 100644 100644 e e e src/e.rs\0\
                   ? notes.txt\0";
        let f = parse_files(raw.as_bytes());
        assert_eq!(f.len(), 4);
        let a = f.iter().find(|x| x.path == "src/a.rs").unwrap();
        assert_eq!((a.staged, a.unstaged), (None, Some('M')));
        let r = f.iter().find(|x| x.path == "new.rs").unwrap();
        assert_eq!(r.orig_path.as_deref(), Some("old.rs"));
        assert_eq!(r.staged, Some('R'));
        assert!(f.iter().find(|x| x.path == "src/e.rs").unwrap().conflicted);
        assert!(f.iter().find(|x| x.path == "notes.txt").unwrap().untracked);
    }

    #[test]
    fn empty_is_clean() {
        assert!(parse(b"").is_clean());
    }
}
