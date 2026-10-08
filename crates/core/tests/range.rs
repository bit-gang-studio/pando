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

// ---- Several branches since they split ---------------------------------------

mod among {
    use super::common::*;
    use pando_core::log;

    fn revs(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }
    fn subjects(l: &log::Log) -> Vec<String> {
        let mut s: Vec<String> = l.entries.iter().map(|e| e.summary.clone()).collect();
        s.sort();
        s
    }

    /// main: m1. a (off m1): a1, a2. b (off m1): b1. c (off a1): c1. Then main: m2.
    fn three() -> Repo {
        let r = repo();
        commit(&r.root, "m1.txt", "1\n");
        for (branch, from, files) in [("a", "main", vec!["a1", "a2"]), ("b", "main", vec!["b1"])] {
            git(&r.root, &["switch", "-q", "-c", branch, from]);
            for f in files {
                commit(&r.root, &format!("{f}.txt"), "x\n");
            }
        }
        git(&r.root, &["switch", "-q", "-c", "c", "a~1"]);
        commit(&r.root, "c1.txt", "x\n");
        git(&r.root, &["switch", "-q", "main"]);
        commit(&r.root, "m2.txt", "2\n");
        r
    }

    #[test]
    fn the_fork_is_the_last_commit_they_all_share() {
        let r = three();
        let core = r.core();
        let m1 = r.tip("main~1");
        assert_eq!(
            log::fork_of(&core, &revs(&["a", "b"])).unwrap(),
            Some(m1.clone())
        );
        assert_eq!(
            log::fork_of(&core, &revs(&["a", "b", "c", "main"])).unwrap(),
            Some(m1)
        );
        // a and c share a1, which is later than where either left main.
        assert_eq!(
            log::fork_of(&core, &revs(&["a", "c"])).unwrap(),
            Some(r.tip("a~1"))
        );
        // One on its own forks from itself.
        assert_eq!(
            log::fork_of(&core, &revs(&["a"])).unwrap(),
            Some(r.tip("a"))
        );
    }

    #[test]
    fn among_lists_what_any_of_them_has_since_the_fork_and_nothing_before() {
        let r = three();
        let core = r.core();
        let all = revs(&["a", "b", "c", "main"]);
        let fork = log::fork_of(&core, &all).unwrap().unwrap();
        let got = log::among(&core, &all, Some(&fork), 100).unwrap();
        assert_eq!(
            subjects(&got),
            [
                "edit a1.txt",
                "edit a2.txt",
                "edit b1.txt",
                "edit c1.txt",
                "edit m2.txt"
            ]
        );
        assert!(!got.truncated);
        // Just two of them: only theirs.
        let two = revs(&["a", "b"]);
        let fork = log::fork_of(&core, &two).unwrap().unwrap();
        assert_eq!(
            subjects(&log::among(&core, &two, Some(&fork), 100).unwrap()),
            ["edit a1.txt", "edit a2.txt", "edit b1.txt"]
        );
        // The limit holds, and says there's more.
        let cut = log::among(&core, &all, Some(&fork), 2).unwrap();
        assert_eq!(cut.entries.len(), 2);
        assert!(cut.truncated);
    }

    #[test]
    fn no_shared_history_has_no_fork_and_nonsense_is_refused() {
        let r = three();
        git(&r.root, &["switch", "-q", "--orphan", "island"]);
        commit(&r.root, "i.txt", "i\n");
        git(&r.root, &["switch", "-q", "main"]);
        let core = r.core();
        assert_eq!(
            log::fork_of(&core, &revs(&["island", "main"])).unwrap(),
            None
        );
        // With nothing to stop at, each one's whole history is listed.
        let got = log::among(&core, &revs(&["island", "a"]), None, 100).unwrap();
        assert!(subjects(&got).contains(&"edit i.txt".to_string()));
        assert!(subjects(&got).contains(&"edit a2.txt".to_string()));

        let e = log::fork_of(&core, &revs(&["a", "nope"]))
            .unwrap_err()
            .to_string();
        assert_eq!(e, "nope isn't a commit or a branch here.");
        for bad in [vec![], vec!["--all"], vec!["a..b"], vec![""], vec!["a"; 9]] {
            assert!(log::fork_of(&core, &revs(&bad)).is_err(), "{bad:?}");
            assert!(log::among(&core, &revs(&bad), None, 10).is_err(), "{bad:?}");
        }
        assert!(log::among(&core, &revs(&["a"]), Some("--all"), 10).is_err());
        // A name with a slash and odd letters.
        git(&r.root, &["branch", "fix/ünï", "a"]);
        assert!(log::fork_of(&core, &revs(&["fix/ünï", "b"]))
            .unwrap()
            .is_some());
    }
}
