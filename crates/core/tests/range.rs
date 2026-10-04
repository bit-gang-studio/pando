//! Several commits picked together, shown as one diff.
mod common;
use common::*;
use pando_core::history;

fn names(r: &history::Range) -> Vec<&str> {
    let mut n: Vec<_> = r.files.iter().map(|f| f.path.as_str()).collect();
    n.sort();
    n
}

#[test]
fn a_run_of_commits_adds_up_and_includes_both_ends() {
    let r = repo();
    commit(&r.root, "a.txt", "a\n");
    let a = r.tip("HEAD");
    commit(&r.root, "b.txt", "b\n");
    commit(&r.root, "a.txt", "a\na2\n");
    let c = r.tip("HEAD");
    commit(&r.root, "after.txt", "x\n");

    let got = history::range(&r.core(), &a, &c).unwrap();
    assert!(got.ancestor);
    assert_eq!(got.count, 3);
    assert_eq!(got.commits.first(), Some(&c));
    assert_eq!(got.commits.last(), Some(&a));
    assert_eq!(names(&got), ["a.txt", "b.txt"], "not README, not after.txt");
    assert_eq!((got.added, got.deleted), (3, 0));
    let d = history::range_file_diff(&r.core(), &got.base, &got.newer, "a.txt").unwrap();
    assert_eq!(d.added, 2);
    // Given the other way round, it's the same range.
    assert_eq!(history::range(&r.core(), &c, &a).unwrap(), got);
    // Short ids work too.
    assert_eq!(history::range(&r.core(), &a[..8], &c[..8]).unwrap(), got);
}

#[test]
fn a_change_made_then_undone_inside_the_range_shows_nothing() {
    let r = repo();
    commit(&r.root, "f.txt", "1\n");
    let a = r.tip("HEAD");
    git(&r.root, &["rm", "-q", "f.txt"]);
    git(&r.root, &["commit", "-q", "-m", "remove"]);
    let b = r.tip("HEAD");
    let got = history::range(&r.core(), &a, &b).unwrap();
    assert_eq!(got.count, 2);
    assert!(got.files.is_empty());
}

#[test]
fn the_first_commit_can_be_in_the_range() {
    let r = repo();
    let first = r.tip("HEAD");
    commit(&r.root, "odd name ü.txt", "x\n");
    let got = history::range(&r.core(), &first, "HEAD").unwrap();
    assert!(got.ancestor);
    assert_eq!(got.count, 2);
    assert_eq!(names(&got), ["README.md", "odd name ü.txt"]);
    let d = history::range_file_diff(&r.core(), &got.base, &got.newer, "README.md").unwrap();
    assert_eq!(d.added, 1);
    // Just the first commit on its own.
    let one = history::range(&r.core(), &first, &first).unwrap();
    assert_eq!((one.count, names(&one)), (1, vec!["README.md"]));
}

#[test]
fn a_merge_inside_the_range_brings_its_side_commits() {
    let r = repo();
    commit(&r.root, "start.txt", "s\n");
    let start = r.tip("HEAD");
    git(&r.root, &["switch", "-q", "-c", "side"]);
    commit(&r.root, "side.txt", "s\n");
    let side = r.tip("HEAD");
    git(&r.root, &["switch", "-q", "main"]);
    commit(&r.root, "main.txt", "m\n");
    git(
        &r.root,
        &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
    );
    let got = history::range(&r.core(), &start, "HEAD").unwrap();
    assert_eq!(names(&got), ["main.txt", "side.txt", "start.txt"]);
    assert_eq!(got.count, 4, "start, main edit, side edit, the merge");
    assert!(got.commits.contains(&side));
}

#[test]
fn two_commits_on_different_lines_are_a_plain_difference() {
    let r = repo();
    git(&r.root, &["switch", "-q", "-c", "left"]);
    commit(&r.root, "left.txt", "l\n");
    let left = r.tip("HEAD");
    git(&r.root, &["switch", "-q", "-c", "right", "main"]);
    commit(&r.root, "right.txt", "r\n");
    let right = r.tip("HEAD");
    let got = history::range(&r.core(), &left, &right).unwrap();
    assert!(!got.ancestor);
    assert_eq!(got.base, left);
    assert_eq!(got.commits, vec![right.clone(), left.clone()]);
    assert_eq!(names(&got), ["left.txt", "right.txt"]);
    // left.txt goes away, right.txt appears: left -> right.
    assert_eq!((got.added, got.deleted), (1, 1));
}

#[test]
fn bad_ids_fail_and_run_nothing() {
    let r = repo();
    let core = r.core();
    for bad in ["nope", "", "--output=/tmp/x", "deadbeef"] {
        assert!(history::range(&core, bad, "HEAD").is_err(), "{bad}");
        assert!(history::range(&core, "HEAD", bad).is_err(), "{bad}");
    }
    let head = r.tip("HEAD");
    for bad in ["--output=pwned", "HEAD", "", "main..x"] {
        assert!(
            history::range_file_diff(&core, bad, &head, "README.md").is_err(),
            "{bad}"
        );
        assert!(
            history::range_file_diff(&core, &head, bad, "README.md").is_err(),
            "{bad}"
        );
    }
    assert!(!r.root.join("pwned").exists());
}
