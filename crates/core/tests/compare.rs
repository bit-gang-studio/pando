//! A branch's changes as one diff, like a pull request's "Files changed".
mod common;
use common::*;
use pando_core::history;

#[test]
fn only_the_branch_changes_not_what_main_did_since() {
    let r = repo();
    git(&r.root, &["switch", "-q", "-c", "feat"]);
    commit(&r.root, "a.txt", "a\n");
    commit(&r.root, "b.txt", "b\n");
    git(&r.root, &["switch", "-q", "main"]);
    commit(&r.root, "main-only.txt", "m\n");

    let c = history::compare(&r.core(), "main", "feat").unwrap();
    assert_eq!((c.ahead, c.behind), (2, 1));
    let mut names: Vec<_> = c.files.iter().map(|f| f.path.as_str()).collect();
    names.sort();
    assert_eq!(names, ["a.txt", "b.txt"]);
    let d = history::compare_file_diff(&r.core(), "main", "feat", "a.txt").unwrap();
    assert_eq!(d.added, 1);
    assert!(
        history::compare_file_diff(&r.core(), "main", "feat", "main-only.txt")
            .unwrap()
            .hunks
            .is_empty()
    );
}

#[test]
fn edits_to_the_same_file_add_up() {
    let r = repo();
    git(&r.root, &["switch", "-q", "-c", "feat"]);
    commit(&r.root, "f.txt", "1\n");
    commit(&r.root, "f.txt", "1\n2\n");
    commit(&r.root, "f.txt", "1\n2\n3\n");
    let c = history::compare(&r.core(), "main", "feat").unwrap();
    assert_eq!(c.files.len(), 1);
    assert_eq!(
        c.files[0].added, 3,
        "one file, all three lines, not three entries"
    );
}

#[test]
fn a_branch_with_nothing_new_is_empty() {
    let r = repo();
    git(&r.root, &["branch", "same"]);
    let c = history::compare(&r.core(), "main", "same").unwrap();
    assert_eq!((c.ahead, c.behind), (0, 0));
    assert!(c.files.is_empty());
}

#[test]
fn unicode_spaces_deletes_and_binary_files() {
    let r = repo();
    commit(&r.root, "old.txt", "gone soon\n");
    git(&r.root, &["switch", "-q", "-c", "feat"]);
    commit(&r.root, "ünï côde/日本 file.txt", "hi\n");
    git(&r.root, &["rm", "-q", "old.txt"]);
    git(&r.root, &["commit", "-q", "-m", "rm"]);
    std::fs::write(r.root.join("logo.bin"), [0u8, 1, 2, 0, 255]).unwrap();
    git(&r.root, &["add", "logo.bin"]);
    git(&r.root, &["commit", "-q", "-m", "bin"]);

    let c = history::compare(&r.core(), "main", "feat").unwrap();
    let names: Vec<_> = c.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        names.contains(&"ünï côde/日本 file.txt"),
        "raw path, not git-quoted: {names:?}"
    );
    assert!(names.contains(&"old.txt") && names.contains(&"logo.bin"));
    let d =
        history::compare_file_diff(&r.core(), "main", "feat", "ünï côde/日本 file.txt").unwrap();
    assert_eq!(d.added, 1);
    assert!(
        history::compare_file_diff(&r.core(), "main", "feat", "logo.bin")
            .unwrap()
            .binary
    );

    // The same raw names in a single commit's file list.
    let first = git(&r.root, &["rev-parse", "feat~2"]);
    let cd = history::commit_diff(&r.core(), &first).unwrap();
    assert_eq!(cd.files[0].path, "ünï côde/日本 file.txt");
}

#[test]
fn unknown_branches_fail_cleanly() {
    let r = repo();
    assert!(history::compare(&r.core(), "main", "nope").is_err());
    assert!(history::compare(&r.core(), "nope", "main").is_err());
}
