//! One conflicted file: both sides, each conflict in it, and ways to resolve it.

use crate::cmd::{git, git_raw};
use crate::error::{Error, Result};
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
    /// The working copy split into plain text and conflicts, top to bottom.
    pub parts: Vec<Part>,
    /// Set when one side deleted the file and the other changed it.
    pub deleted: Option<Side>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
    Text {
        text: String,
    },
    Conflict {
        ours: String,
        /// The original lines, when git or `merge-file` can tell us.
        base: Option<String>,
        theirs: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Ours,
    Theirs,
    Both,
}

/// How to settle one conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Choice {
    Ours,
    Theirs,
    /// Ours, then theirs.
    Both,
    Base,
    Text {
        text: String,
    },
}

fn stage(wt: &Path, n: u8, path: &str) -> Result<Option<String>> {
    let (code, out, _) = git_raw(wt, ["show", &format!(":{n}:{path}")])?;
    Ok(if code == 0 { Some(out) } else { None })
}

pub fn file(wt: &Path, path: &str) -> Result<ConflictFile> {
    let working_bytes = std::fs::read(wt.join(path)).unwrap_or_default();
    let binary = working_bytes.iter().take(8000).any(|b| *b == 0);
    let ours = stage(wt, 2, path)?;
    let theirs = stage(wt, 3, path)?;
    let base = stage(wt, 1, path)?;
    let working = String::from_utf8_lossy(&working_bytes).into_owned();
    let deleted = match (&ours, &theirs) {
        (None, Some(_)) => Some(Side::Ours),
        (Some(_), None) => Some(Side::Theirs),
        _ => None,
    };
    let mut parts = if binary { vec![] } else { parse(&working) };
    if let (Some(o), Some(t), Some(b)) = (&ours, &theirs, &base) {
        if parts
            .iter()
            .any(|p| matches!(p, Part::Conflict { base: None, .. }))
        {
            fill_bases(wt, &mut parts, o, b, t);
        }
    }
    Ok(ConflictFile {
        path: path.to_string(),
        ours: ours.unwrap_or_default(),
        theirs: theirs.unwrap_or_default(),
        base,
        working,
        binary,
        parts,
        deleted,
    })
}

/// Number of conflicts left in the working copy.
pub fn count(wt: &Path, path: &str) -> u32 {
    let text = std::fs::read(wt.join(path)).unwrap_or_default();
    parse(&String::from_utf8_lossy(&text))
        .iter()
        .filter(|p| matches!(p, Part::Conflict { .. }))
        .count() as u32
}

/// A marker line: exactly seven of `c`, then a space or the end of the line.
/// Longer runs are markers from an inner merge, and stay as text.
fn marker(line: &str, c: char) -> bool {
    let t = line.trim_end_matches(['\n', '\r']);
    let n = t.chars().take_while(|x| *x == c).count();
    n == 7 && (t.len() == 7 || t[7..].starts_with(' '))
}

/// Split a file with conflict markers into text and conflicts. Handles the
/// merge, diff3 and zdiff3 styles. A conflict with no end stays as text.
pub fn parse(text: &str) -> Vec<Part> {
    #[derive(PartialEq)]
    enum S {
        Normal,
        Ours,
        Base,
        Theirs,
    }
    let mut parts = vec![];
    let mut plain = String::new();
    let (mut raw, mut ours, mut base, mut theirs) =
        (String::new(), String::new(), None::<String>, String::new());
    let mut st = S::Normal;
    for line in text.split_inclusive('\n') {
        match st {
            S::Normal if marker(line, '<') => {
                st = S::Ours;
                raw = line.to_string();
                ours.clear();
                theirs.clear();
                base = None;
            }
            S::Normal => plain.push_str(line),
            S::Ours if marker(line, '|') => {
                raw.push_str(line);
                base = Some(String::new());
                st = S::Base;
            }
            S::Ours | S::Base if marker(line, '=') => {
                raw.push_str(line);
                st = S::Theirs;
            }
            S::Ours => {
                raw.push_str(line);
                ours.push_str(line);
            }
            S::Base => {
                raw.push_str(line);
                base.get_or_insert_with(String::new).push_str(line);
            }
            S::Theirs if marker(line, '>') => {
                if !plain.is_empty() {
                    parts.push(Part::Text {
                        text: std::mem::take(&mut plain),
                    });
                }
                parts.push(Part::Conflict {
                    ours: std::mem::take(&mut ours),
                    base: base.take(),
                    theirs: std::mem::take(&mut theirs),
                });
                st = S::Normal;
            }
            S::Theirs => {
                raw.push_str(line);
                theirs.push_str(line);
            }
        }
    }
    if st != S::Normal {
        plain.push_str(&raw);
    }
    if !plain.is_empty() {
        parts.push(Part::Text { text: plain });
    }
    parts
}

/// The working copy has no original lines (the default merge style), so
/// redo the merge with zdiff3 in a temp folder and borrow them from there.
/// A conflict only gets a base when both sides match exactly.
fn fill_bases(wt: &Path, parts: &mut [Part], ours: &str, base: &str, theirs: &str) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("pando-conflict-{}-{stamp}", std::process::id()));
    let redo = (|| -> Option<Vec<Part>> {
        std::fs::create_dir_all(&dir).ok()?;
        let files = [("ours", ours), ("base", base), ("theirs", theirs)];
        for (name, body) in files {
            std::fs::write(dir.join(name), body).ok()?;
        }
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        let (code, out, _) = git_raw(
            wt,
            [
                "merge-file",
                "-p",
                "--zdiff3",
                &p("ours"),
                &p("base"),
                &p("theirs"),
            ],
        )
        .ok()?;
        (code >= 0).then(|| parse(&out))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    let Some(redo) = redo else { return };
    for part in parts.iter_mut() {
        let Part::Conflict {
            ours: o,
            base: b @ None,
            theirs: t,
        } = part
        else {
            continue;
        };
        *b = redo.iter().find_map(|r| match r {
            Part::Conflict {
                ours,
                base: Some(base),
                theirs,
            } if ours == o && theirs == t => Some(base.clone()),
            _ => None,
        });
    }
}

/// Settle every conflict in the file, one choice each in order, then stage it.
/// Refuses if the file changed since it was read.
pub fn choose(wt: &Path, path: &str, choices: &[Choice]) -> Result<()> {
    let working = std::fs::read_to_string(wt.join(path))?;
    let parts = parse(&working);
    let conflicts = parts
        .iter()
        .filter(|p| matches!(p, Part::Conflict { .. }))
        .count();
    if conflicts == 0 || conflicts != choices.len() {
        return Err(Error::Msg(format!(
            "{path} changed since it was opened. Reload it and pick again."
        )));
    }
    let mut out = String::with_capacity(working.len());
    let mut picks = choices.iter();
    for part in parts {
        match part {
            Part::Text { text } => out.push_str(&text),
            Part::Conflict { ours, base, theirs } => match picks.next().unwrap() {
                Choice::Ours => out.push_str(&ours),
                Choice::Theirs => out.push_str(&theirs),
                Choice::Both => {
                    out.push_str(&ours);
                    // Keep a line break between the two when ours has none.
                    if !ours.is_empty() && !ours.ends_with('\n') {
                        out.push('\n');
                    }
                    out.push_str(&theirs);
                }
                Choice::Base => match base {
                    Some(b) => out.push_str(&b),
                    None => {
                        return Err(Error::Msg(format!(
                            "{path} has no original version for this conflict."
                        )))
                    }
                },
                Choice::Text { text } => out.push_str(text),
            },
        }
    }
    resolve(wt, path, &out)
}

/// Write `content` as the resolution and stage it.
pub fn resolve(wt: &Path, path: &str, content: &str) -> Result<()> {
    std::fs::write(wt.join(path), content)?;
    git(wt, ["add", "--", path])?;
    Ok(())
}

/// Resolve with one side, or both sides kept in order. Taking a side that
/// deleted the file deletes it.
pub fn take(wt: &Path, path: &str, side: Side) -> Result<()> {
    let (flag, n) = match side {
        Side::Ours => ("--ours", 2),
        Side::Theirs => ("--theirs", 3),
        Side::Both => {
            let working = std::fs::read_to_string(wt.join(path))?;
            std::fs::write(wt.join(path), keep_both(&working))?;
            git(wt, ["add", "--", path])?;
            return Ok(());
        }
    };
    if stage(wt, n, path)?.is_none() {
        git(wt, ["rm", "--quiet", "--", path])?;
        return Ok(());
    }
    git(wt, ["checkout", flag, "--", path])?;
    git(wt, ["add", "--", path])?;
    Ok(())
}

/// Put the file back to its conflicted state.
pub fn reset(wt: &Path, path: &str) -> Result<()> {
    git(wt, ["checkout", "-m", "--", path])?;
    Ok(())
}

/// Replace each conflict with ours followed by theirs.
pub fn keep_both(text: &str) -> String {
    parse(text)
        .into_iter()
        .map(|p| match p {
            Part::Text { text } => text,
            Part::Conflict { ours, theirs, .. } => ours + &theirs,
        })
        .collect()
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
        assert_eq!(
            parse(t),
            vec![Part::Conflict {
                ours: "o\n".into(),
                base: Some("b\n".into()),
                theirs: "t\n".into()
            }]
        );
    }

    #[test]
    fn longer_markers_from_an_inner_merge_stay_text() {
        let t = "<<<<<<< HEAD\n<<<<<<<<< inner\nx\n=========\ny\n>>>>>>>>> inner\n=======\nt\n>>>>>>> x\n";
        let p = parse(t);
        assert_eq!(p.len(), 1);
        let Part::Conflict { ours, theirs, .. } = &p[0] else {
            panic!()
        };
        assert_eq!(ours, "<<<<<<<<< inner\nx\n=========\ny\n>>>>>>>>> inner\n");
        assert_eq!(theirs, "t\n");
    }

    #[test]
    fn a_conflict_with_no_end_stays_text() {
        let t = "a\n<<<<<<< HEAD\nb\n=======\nc\n";
        assert_eq!(parse(t), vec![Part::Text { text: t.into() }]);
    }

    #[test]
    fn crlf_markers_and_empty_sides() {
        let t = "<<<<<<< HEAD\r\n=======\r\nt\r\n>>>>>>> x\r\nz\r\n";
        assert_eq!(
            parse(t),
            vec![
                Part::Conflict {
                    ours: "".into(),
                    base: None,
                    theirs: "t\r\n".into()
                },
                Part::Text {
                    text: "z\r\n".into()
                }
            ]
        );
    }

    #[test]
    fn marker_needs_exactly_seven_then_space() {
        assert!(marker("<<<<<<< HEAD\n", '<'));
        assert!(marker("=======\n", '='));
        assert!(!marker("<<<<<<<< HEAD\n", '<'));
        assert!(!marker("<<<<<<<x\n", '<'));
        assert!(!marker("======", '='));
    }
}
