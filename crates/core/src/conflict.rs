//! One conflicted file: both sides, the working copy, and ways to resolve it.

use crate::cmd::{git, git_raw};
use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictFile {
    pub path: String,
    /// Stage 2: the side that was already there (HEAD).
    pub ours: String,
    /// Stage 3: the side being brought in.
    pub theirs: String,
    /// Stage 1: common ancestor, if any.
    pub base: Option<String>,
    /// Current working copy, usually with conflict markers.
    pub working: String,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Ours,
    Theirs,
    Both,
}

fn stage(wt: &Path, n: u8, path: &str) -> Result<Option<String>> {
    let (code, out, _) = git_raw(wt, ["show", &format!(":{n}:{path}")])?;
    Ok(if code == 0 { Some(out) } else { None })
}

pub fn file(wt: &Path, path: &str) -> Result<ConflictFile> {
    let working_bytes = std::fs::read(wt.join(path)).unwrap_or_default();
    let binary = working_bytes.iter().take(8000).any(|b| *b == 0);
    Ok(ConflictFile {
        path: path.to_string(),
        ours: stage(wt, 2, path)?.unwrap_or_default(),
        theirs: stage(wt, 3, path)?.unwrap_or_default(),
        base: stage(wt, 1, path)?,
        working: String::from_utf8_lossy(&working_bytes).into_owned(),
        binary,
    })
}

/// Write `content` as the resolution and stage it.
pub fn resolve(wt: &Path, path: &str, content: &str) -> Result<()> {
    std::fs::write(wt.join(path), content)?;
    git(wt, ["add", "--", path])?;
    Ok(())
}

/// Resolve with one side, or both sides kept in order.
pub fn take(wt: &Path, path: &str, side: Side) -> Result<()> {
    match side {
        Side::Ours => {
            git(wt, ["checkout", "--ours", "--", path])?;
        }
        Side::Theirs => {
            git(wt, ["checkout", "--theirs", "--", path])?;
        }
        Side::Both => {
            let working = std::fs::read_to_string(wt.join(path))?;
            std::fs::write(wt.join(path), keep_both(&working))?;
        }
    }
    git(wt, ["add", "--", path])?;
    Ok(())
}

/// Put the file back to its conflicted state.
pub fn reset(wt: &Path, path: &str) -> Result<()> {
    git(wt, ["checkout", "-m", "--", path])?;
    Ok(())
}

/// Replace each conflict block with ours followed by theirs. Handles diff3 markers.
pub fn keep_both(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut ours = String::new();
    let mut theirs = String::new();
    #[derive(PartialEq)]
    enum S {
        Normal,
        Ours,
        Base,
        Theirs,
    }
    let mut st = S::Normal;
    for line in text.split_inclusive('\n') {
        let t = line.trim_end_matches(['\n', '\r']);
        match st {
            S::Normal if t.starts_with("<<<<<<<") => {
                st = S::Ours;
                ours.clear();
                theirs.clear();
            }
            S::Normal => out.push_str(line),
            S::Ours if t.starts_with("|||||||") => st = S::Base,
            S::Ours if t.starts_with("=======") => st = S::Theirs,
            S::Ours => ours.push_str(line),
            S::Base if t.starts_with("=======") => st = S::Theirs,
            S::Base => {}
            S::Theirs if t.starts_with(">>>>>>>") => {
                out.push_str(&ours);
                out.push_str(&theirs);
                st = S::Normal;
            }
            S::Theirs => theirs.push_str(line),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_both_sides() {
        let t = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feat\nz\n";
        assert_eq!(keep_both(t), "a\nours\ntheirs\nz\n");
    }

    #[test]
    fn handles_diff3_markers() {
        let t = "<<<<<<< HEAD\no\n||||||| base\nb\n=======\nt\n>>>>>>> x\n";
        assert_eq!(keep_both(t), "o\nt\n");
    }
}
