//! File history and blame.
mod common;
use common::*;
use pando_core::file;
use std::path::Path;

fn commit_as(cwd: &Path, author: &str, file: &str, body: &str, message: &str) -> String {
    write(cwd, file, body);
    git(cwd, &["add", "-A"]);
    git(
        cwd,
        &[
            "-c",
            &format!("user.name={author}"),
            "-c",
            "user.email=x@e",
            "commit",
            "-q",
            "-m",
            message,
        ],
    );
    git(cwd, &["rev-parse", "HEAD"])
}
fn summaries(h: &file::FileHistory) -> Vec<&str> {
    h.commits.iter().map(|c| c.entry.summary.as_str()).collect()
}

/// notes.txt: added by Ana, edited by Sam, renamed to "docs/my notes ü.txt"
/// (with an edit) by Ana. other.txt is touched in between and must not show.
fn fixture() -> (Repo, Vec<String>) {
    let r = repo();
    let root = &r.root;
    let a = commit_as(
        root,
        "Ana",
        "notes.txt",
        "one\ntwo\nthree\nfour\nfive\nsix\n",
        "Add notes",
    );
    commit_as(root, "Sam", "other.txt", "x\n", "Unrelated");
    let b = commit_as(
        root,
        "Sam",
        "notes.txt",
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "Shout two",
    );
    std::fs::create_dir(root.join("docs")).unwrap();
    git(root, &["mv", "notes.txt", "docs/my notes ü.txt"]);
    let c = commit_as(
        root,
        "Ana",
        "docs/my notes ü.txt",
        "one\nTWO\nthree\nfour\nfive\nsix\nseven\n",
        "Move notes and add seven",
    );
    (r, vec![a, b, c])
}

#[test]
fn history_follows_a_rename_and_skips_other_files() {
    let (r, ids) = fixture();
    let h = file::history(&r.core(), None, "docs/my notes ü.txt", 0, 50).unwrap();
    assert_eq!(
        summaries(&h),
        ["Move notes and add seven", "Shout two", "Add notes"]
    );
    assert_eq!(
        h.commits
            .iter()
            .map(|c| c.entry.id.as_str())
            .collect::<Vec<_>>(),
        [&ids[2], &ids[1], &ids[0]]
    );
    // Each commit knows what the file was called then, and what happened.
    assert_eq!(
        h.commits
            .iter()
            .map(|c| (c.path.as_str(), c.change.as_str()))
            .collect::<Vec<_>>(),
        [
            ("docs/my notes ü.txt", "R"),
            ("notes.txt", "M"),
            ("notes.txt", "A")
        ]
    );
    assert_eq!(h.commits[1].entry.author, "Sam");
    assert!(!h.truncated);
    // That name is good for asking for the commit's change to the file.
    let d = pando_core::history::commit_file_diff(&r.core(), &ids[1], &h.commits[1].path).unwrap();
    assert_eq!((d.added, d.deleted), (1, 1));
}

#[test]
fn history_from_an_older_commit_and_under_the_old_name() {
    let (r, ids) = fixture();
    let core = r.core();
    let h = file::history(&core, Some(&ids[1]), "notes.txt", 0, 50).unwrap();
    assert_eq!(summaries(&h), ["Shout two", "Add notes"]);
    // Asked for by today's name at a commit where it didn't exist yet: nothing.
    assert!(
        file::history(&core, Some(&ids[1]), "docs/my notes ü.txt", 0, 50)
            .unwrap()
            .commits
            .is_empty()
    );
    // A file that never existed: nothing, not an error.
    assert!(file::history(&core, None, "never.txt", 0, 50)
        .unwrap()
        .commits
        .is_empty());
    // A deleted file still has its history, ending in the delete.
    git(&r.root, &["rm", "-q", "other.txt"]);
    git(&r.root, &["commit", "-q", "-m", "Remove other"]);
    let gone = file::history(&core, None, "other.txt", 0, 50).unwrap();
    assert_eq!(summaries(&gone), ["Remove other", "Unrelated"]);
    assert_eq!(gone.commits[0].change, "D");
}

#[test]
fn history_pages_without_gaps() {
    let r = repo();
    for i in 0..7 {
        commit_as(
            &r.root,
            "Sam",
            "f.txt",
            &format!("{i}\n"),
            &format!("edit {i}"),
        );
    }
    let core = r.core();
    let first = file::history(&core, None, "f.txt", 0, 3).unwrap();
    assert!(first.truncated);
    assert_eq!(summaries(&first), ["edit 6", "edit 5", "edit 4"]);
    let rest = file::history(&core, None, "f.txt", 3, 10).unwrap();
    assert!(!rest.truncated);
    assert_eq!(summaries(&rest), ["edit 3", "edit 2", "edit 1", "edit 0"]);
}

#[test]
fn blame_names_who_last_changed_each_line() {
    let (r, ids) = fixture();
    let b = file::blame(&r.core(), None, None, "docs/my notes ü.txt").unwrap();
    assert_eq!(
        b.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        ["one", "TWO", "three", "four", "five", "six", "seven"]
    );
    let who = |i: usize| b.commits[&b.lines[i].commit].author.as_str();
    assert_eq!(
        (who(0), who(1), who(2), who(6)),
        ("Ana", "Sam", "Ana", "Ana")
    );
    assert_eq!(b.lines[1].commit, ids[1]);
    assert_eq!(b.lines[6].commit, ids[2]);
    let two = &b.commits[&ids[1]];
    assert_eq!(
        (two.summary.as_str(), two.path.as_str()),
        ("Shout two", "notes.txt")
    );
    assert!(two.time > 1_600_000_000);
    assert_eq!(b.commits.len(), 3);
}

#[test]
fn blame_marks_lines_that_arent_committed_yet() {
    let (r, _) = fixture();
    write(
        &r.root,
        "docs/my notes ü.txt",
        "zero\none\nTWO\nthree\nfour\nfive\nsix\nseven\n",
    );
    let b = file::blame(&r.core(), Some(&r.root), None, "docs/my notes ü.txt").unwrap();
    assert_eq!(b.lines[0].text, "zero");
    assert_eq!(b.lines[0].commit, "", "not committed yet");
    assert!(!b.lines[1].commit.is_empty());
    assert!(b.commits.keys().all(|k| !k.starts_with("0000000")));
    // At a commit, the working copy doesn't come into it.
    let old = file::blame(&r.core(), None, Some("HEAD"), "docs/my notes ü.txt").unwrap();
    assert_eq!(old.lines[0].text, "one");
    assert_eq!(old.lines.len(), 7);
}

#[test]
fn blame_in_a_linked_worktree_and_at_an_old_commit() {
    let (r, ids) = fixture();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    commit_as(
        &wt,
        "Lee",
        "docs/my notes ü.txt",
        "one\nTWO\nthree\nFOUR\nfive\nsix\nseven\n",
        "Shout four",
    );
    let core = r.core();
    let there = file::blame(&core, Some(&wt), None, "docs/my notes ü.txt").unwrap();
    assert_eq!(there.commits[&there.lines[3].commit].author, "Lee");
    // The main worktree doesn't have that commit.
    let here = file::blame(&core, Some(&r.root), None, "docs/my notes ü.txt").unwrap();
    assert_eq!(here.commits[&here.lines[3].commit].author, "Ana");
    // As of the second commit, under its old name.
    let then = file::blame(&core, None, Some(&ids[1]), "notes.txt").unwrap();
    assert_eq!(then.lines.len(), 6);
    assert_eq!(then.commits[&then.lines[1].commit].author, "Sam");
}

#[test]
fn blame_refuses_what_it_cant_show_in_plain_words() {
    let (r, _) = fixture();
    let core = r.core();
    let e = |rev: Option<&str>, path: &str| {
        file::blame(&core, Some(&r.root), rev, path)
            .unwrap_err()
            .to_string()
    };
    assert_eq!(e(None, "never.txt"), "never.txt doesn't exist here.");
    assert_eq!(
        e(Some("HEAD"), "never.txt"),
        "never.txt doesn't exist here."
    );
    std::fs::write(r.root.join("pic.bin"), [0u8, 1, 2, 0, 9]).unwrap();
    git(&r.root, &["add", "pic.bin"]);
    git(&r.root, &["commit", "-q", "-m", "binary"]);
    assert_eq!(e(None, "pic.bin"), "pic.bin is a binary file.");
    std::fs::write(r.root.join("huge.txt"), "x\n".repeat(1_100_000)).unwrap();
    assert_eq!(
        e(None, "huge.txt"),
        "huge.txt is too large to blame line by line."
    );
    // A new file that was never committed: every line is uncommitted.
    write(&r.root, "brand new.txt", "a\nb\n");
    git(&r.root, &["add", "brand new.txt"]);
    let b = file::blame(&core, Some(&r.root), None, "brand new.txt").unwrap();
    assert!(b.lines.iter().all(|l| l.commit.is_empty()) && b.lines.len() == 2);
}

#[test]
fn odd_paths_and_revs_are_refused_before_git_sees_them() {
    let (r, _) = fixture();
    let core = r.core();
    for bad in ["", "/etc/passwd", "../outside.txt", "a/../../b", "has\0nul"] {
        assert!(file::history(&core, None, bad, 0, 10).is_err(), "{bad:?}");
        assert!(file::blame(&core, None, None, bad).is_err(), "{bad:?}");
    }
    for bad in ["", "--all", "-n1", "main..feat"] {
        assert!(
            file::history(&core, Some(bad), "notes.txt", 0, 10).is_err(),
            "{bad:?}"
        );
        assert!(
            file::blame(&core, None, Some(bad), "notes.txt").is_err(),
            "{bad:?}"
        );
    }
    assert!(file::history(&core, Some("no-such-branch"), "notes.txt", 0, 10).is_err());
    // A file whose name looks like an option is just a file.
    commit_as(
        &r.root,
        "Sam",
        "--force",
        "only in the flag-named file\n",
        "A file named like a flag",
    );
    assert_eq!(
        file::history(&core, None, "--force", 0, 10)
            .unwrap()
            .commits
            .len(),
        1
    );
    assert_eq!(
        file::blame(&core, None, None, "--force")
            .unwrap()
            .lines
            .len(),
        1
    );
}

#[test]
fn crlf_and_no_final_newline() {
    let r = repo();
    git(&r.root, &["config", "core.autocrlf", "false"]);
    commit_as(
        &r.root,
        "Sam",
        "win.txt",
        "one\r\ntwo\r\nlast without newline",
        "crlf",
    );
    let b = file::blame(&r.core(), None, None, "win.txt").unwrap();
    assert_eq!(
        b.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        ["one", "two", "last without newline"]
    );
}
