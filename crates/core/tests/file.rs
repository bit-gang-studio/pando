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

// ---- The files as they are: list, read, find --------------------------------

fn names(v: &[file::Entry]) -> Vec<String> {
    v.iter()
        .map(|e| format!("{}{}", e.name, if e.dir { "/" } else { "" }))
        .collect()
}

/// src/app.rs and "docs/my notes ü.txt" committed; then on disk: a new file,
/// an edit, an ignored folder and an ignored file.
fn tree_fixture() -> (Repo, String) {
    let r = repo();
    write(&r.root, "src/app.rs", "fn main() {}\n");
    write(&r.root, "docs/my notes ü.txt", "one\n");
    write(&r.root, ".gitignore", "node_modules/\n*.log\n");
    git(&r.root, &["add", "-A"]);
    git(&r.root, &["commit", "-q", "-m", "tree"]);
    let at = r.tip("HEAD");
    write(&r.root, "src/new.rs", "// new\n");
    write(&r.root, "src/app.rs", "fn main() { edited(); }\n");
    write(&r.root, "node_modules/x/index.js", "x\n");
    write(&r.root, "debug.log", "noise\n");
    (r, at)
}

#[test]
fn list_on_disk_shows_new_files_hides_ignored_and_git_itself() {
    let (r, _) = tree_fixture();
    let core = r.core();
    let top = file::list(&core, None, None, "").unwrap();
    // Folders first, then names without regard to case. No .git, nothing ignored.
    assert_eq!(names(&top), ["docs/", "src/", ".gitignore", "README.md"]);
    let src = file::list(&core, None, None, "src").unwrap();
    assert_eq!(names(&src), ["app.rs", "new.rs"]);
    assert_eq!(src[1].path, "src/new.rs");
    let docs = file::list(&core, None, None, "docs/").unwrap();
    assert_eq!(docs[0].path, "docs/my notes ü.txt");
}

#[test]
fn list_at_a_commit_shows_that_commit_not_the_disk() {
    let (r, at) = tree_fixture();
    let core = r.core();
    assert_eq!(
        names(&file::list(&core, None, Some(&at), "").unwrap()),
        ["docs/", "src/", ".gitignore", "README.md"]
    );
    assert_eq!(
        names(&file::list(&core, None, Some(&at), "src").unwrap()),
        ["app.rs"]
    );
    assert_eq!(
        names(&file::list(&core, None, Some("main"), "docs").unwrap()),
        ["my notes ü.txt"]
    );
}

#[test]
fn list_in_a_linked_worktree_is_that_folder_not_the_main_one() {
    let (r, _) = tree_fixture();
    let wt = add_worktree(&r, "feat/a", "work-feat-a");
    write(&wt, "only-here.txt", "x\n");
    let core = r.core();
    let there = names(&file::list(&core, Some(&wt), None, "").unwrap());
    assert!(there.contains(&"only-here.txt".to_string()));
    // A linked worktree's .git is a file; still not part of the tree.
    assert!(!there
        .iter()
        .any(|n| n.starts_with(".git") && n != ".gitignore"));
    assert!(
        !names(&file::list(&core, None, None, "").unwrap()).contains(&"only-here.txt".to_string())
    );
}

#[test]
fn list_refuses_paths_that_leave_the_repository_and_says_when_a_folder_is_missing() {
    let (r, at) = tree_fixture();
    let core = r.core();
    for bad in ["..", "../x", "src/../..", "/etc"] {
        assert!(file::list(&core, None, None, bad).is_err(), "{bad}");
        assert!(file::list(&core, None, Some(&at), bad).is_err(), "{bad}");
    }
    let e = file::list(&core, None, None, "nope")
        .unwrap_err()
        .to_string();
    assert_eq!(e, "nope doesn't exist here.");
    let e = file::list(&core, None, Some(&at), "nope")
        .unwrap_err()
        .to_string();
    assert!(e.starts_with("nope doesn't exist at "), "{e}");
    assert!(file::list(&core, None, Some("--output=/tmp/x"), "").is_err());
}

#[test]
fn read_gives_the_disk_or_the_commit() {
    let (r, at) = tree_fixture();
    let core = r.core();
    let now = file::read(&core, None, None, "src/app.rs").unwrap();
    assert_eq!(now.text.as_deref(), Some("fn main() { edited(); }\n"));
    assert_eq!(now.why, None);
    let then = file::read(&core, None, Some(&at), "src/app.rs").unwrap();
    assert_eq!(then.text.as_deref(), Some("fn main() {}\n"));
    assert_eq!(then.size, 13);
    let odd = file::read(&core, None, Some("main"), "docs/my notes ü.txt").unwrap();
    assert_eq!(odd.text.as_deref(), Some("one\n"));
    // Not committed: on disk only.
    assert!(file::read(&core, None, None, "src/new.rs").is_ok());
    let e = file::read(&core, None, Some(&at), "src/new.rs")
        .unwrap_err()
        .to_string();
    assert!(e.starts_with("src/new.rs doesn't exist at "), "{e}");
    assert_eq!(
        file::read(&core, None, None, "gone.txt")
            .unwrap_err()
            .to_string(),
        "gone.txt doesn't exist here."
    );
}

#[test]
fn read_says_why_when_there_is_nothing_to_show() {
    let (r, _) = tree_fixture();
    std::fs::write(r.root.join("pic.bin"), [1u8, 0, 2, 0, 3]).unwrap();
    std::fs::write(r.root.join("big.txt"), vec![b'a'; 1_000_001]).unwrap();
    std::fs::write(r.root.join("empty.txt"), b"").unwrap();
    git(&r.root, &["add", "-A"]);
    git(&r.root, &["commit", "-q", "-m", "odd files"]);
    let core = r.core();
    for rev in [None, Some("HEAD")] {
        let b = file::read(&core, None, rev, "pic.bin").unwrap();
        assert_eq!(
            (b.text, b.why.as_deref()),
            (None, Some("This is a binary file."))
        );
        let big = file::read(&core, None, rev, "big.txt").unwrap();
        assert_eq!(big.why.as_deref(), Some("This file is too large to show."));
        assert_eq!(big.size, 1_000_001);
        let empty = file::read(&core, None, rev, "empty.txt").unwrap();
        assert_eq!(empty.text.as_deref(), Some(""));
        // A folder isn't a file.
        assert!(file::read(&core, None, rev, "src").is_err());
        for bad in ["../x", "/etc/passwd", "src/../../x", ""] {
            assert!(file::read(&core, None, rev, bad).is_err(), "{bad}");
        }
    }
}

#[cfg(unix)]
#[test]
fn read_never_follows_a_link_out_of_the_repository() {
    let (r, _) = tree_fixture();
    let secret = r.base.join("secret.txt");
    std::fs::write(&secret, "do not show\n").unwrap();
    std::os::unix::fs::symlink(&secret, r.root.join("link.txt")).unwrap();
    let got = file::read(&r.core(), None, None, "link.txt").unwrap();
    assert_eq!(got.text, None);
    assert!(got.why.unwrap().starts_with("A link to "));
}

#[test]
fn find_matches_every_word_names_first_and_respects_the_limit() {
    let (r, at) = tree_fixture();
    write(&r.root, "docs/app-guide.md", "g\n");
    let core = r.core();
    let on_disk = file::find(&core, None, None, "APP", 50).unwrap();
    // New and edited files are found; the ignored ones aren't.
    assert_eq!(on_disk.paths, ["docs/app-guide.md", "src/app.rs"]);
    assert!(!on_disk.truncated);
    // A word can match the folder, but a match in the name comes first.
    let src = file::find(&core, None, None, "src rs", 50).unwrap();
    assert_eq!(src.paths, ["src/app.rs", "src/new.rs"]);
    assert!(file::find(&core, None, None, "node_modules", 50)
        .unwrap()
        .paths
        .is_empty());
    assert!(file::find(&core, None, None, "log", 50)
        .unwrap()
        .paths
        .is_empty());
    // At a commit: only what was committed.
    assert_eq!(
        file::find(&core, None, Some(&at), "rs", 50).unwrap().paths,
        ["src/app.rs"]
    );
    assert_eq!(
        file::find(&core, None, Some(&at), "notes ü", 50)
            .unwrap()
            .paths,
        ["docs/my notes ü.txt"]
    );
    let one = file::find(&core, None, None, "s", 1).unwrap();
    assert_eq!(one.paths.len(), 1);
    assert!(one.truncated);
    assert!(file::find(&core, None, None, "   ", 50)
        .unwrap()
        .paths
        .is_empty());
    assert!(file::find(&core, None, Some("--all"), "x", 50).is_err());
}
