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
    fn empty_is_clean() {
        assert!(parse(b"").is_clean());
    }
}
