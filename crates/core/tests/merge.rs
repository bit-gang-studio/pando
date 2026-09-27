//! Merge in GitHub's three styles. Merge only merges: no push, no delete.
mod common;
use common::*;
use pando_core::{merge, MergePlan, Strategy};

/// main: README, then "main-moved". feat/x (in worktree `wt`): x1, x2.
fn fixture() -> (Repo, std::path::PathBuf) {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "x1.txt", "1\n");
    commit(&wt, "x2.txt", "2\n");
    commit(&r.root, "main.txt", "moved\n");
    (r, wt)
}

fn plan(strategy: Strategy) -> MergePlan {
    MergePlan {
        branch: "feat/x".into(),
        base: "main".into(),
        strategy,
        message: Some("Merge feat/x".into()),
    }
}

fn subjects(r: &Repo, n: usize) -> Vec<String> {
    git(&r.root, &["log", &format!("-{n}"), "--format=%s", "main"])
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn preflight_counts_and_predicts() {
    let (r, wt) = fixture();
    let p = merge::preflight(&r.core(), Some(&wt), "feat/x", "main").unwrap();
    assert_eq!((p.ahead, p.behind), (2, 1));
    assert!(!p.conflict_predicted);
    assert!(p.problems.is_empty(), "{:?}", p.problems);
    assert_eq!(p.last_summary.as_deref(), Some("edit x2.txt"));
}

#[test]
fn preflight_names_the_conflicting_files() {
    let (r, wt) = fixture();
    commit(&wt, "main.txt", "branch side\n");
    let p = merge::preflight(&r.core(), Some(&wt), "feat/x", "main").unwrap();
    assert!(p.conflict_predicted);
    assert_eq!(p.conflict_files, vec!["main.txt"]);
}

#[test]
fn squash_makes_one_commit_with_the_message() {
    let (r, wt) = fixture();
    let res = merge::run(&r.core(), Some(&wt), &plan(Strategy::Squash)).unwrap();
    assert!(res.merged, "{:#?}", res.steps);
    assert_eq!(subjects(&r, 2), ["Merge feat/x", "edit main.txt"]);
    assert_eq!(read(&r.root, "x2.txt"), "2\n", "main's worktree updated");
}

#[test]
fn rebase_keeps_each_commit_in_a_line() {
    let (r, wt) = fixture();
    let res = merge::run(&r.core(), Some(&wt), &plan(Strategy::Rebase)).unwrap();
    assert!(res.merged, "{:#?}", res.steps);
    assert_eq!(
        subjects(&r, 3),
        ["edit x2.txt", "edit x1.txt", "edit main.txt"]
    );
    assert_eq!(
        git(&r.root, &["log", "-1", "--format=%P", "main"])
            .split(' ')
            .count(),
        1
    );
}

#[test]
fn merge_commit_has_two_parents() {
    let (r, wt) = fixture();
    let res = merge::run(&r.core(), Some(&wt), &plan(Strategy::MergeCommit)).unwrap();
    assert!(res.merged, "{:#?}", res.steps);
    assert_eq!(subjects(&r, 1), ["Merge feat/x"]);
    assert_eq!(
        git(&r.root, &["log", "-1", "--format=%P", "main"])
            .split(' ')
            .count(),
        2
    );
}

#[test]
fn merge_never_pushes_or_deletes() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, wt) = fixture();
        let origin_main = r.tip("origin/main");
        let res = merge::run(&r.core(), Some(&wt), &plan(strategy)).unwrap();
        assert!(res.merged);
        assert!(wt.exists(), "{strategy:?} kept the worktree");
        assert!(
            git_ok(&r.root, &["rev-parse", "--verify", "feat/x"]),
            "{strategy:?} kept the branch"
        );
        assert_eq!(
            git(&r.origin, &["rev-parse", "main"]),
            origin_main,
            "{strategy:?} pushed"
        );
    }
}

#[test]
fn merge_when_main_is_not_checked_out_anywhere() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, wt) = fixture();
        git(&r.root, &["switch", "-q", "--detach"]);
        let res = merge::run(&r.core(), Some(&wt), &plan(strategy)).unwrap();
        assert!(res.merged, "{strategy:?}: {:#?}", res.steps);
        assert!(
            git(&r.root, &["ls-tree", "--name-only", "main"]).contains("x2.txt"),
            "{strategy:?} main has the change"
        );
        assert_eq!(
            git(&r.root, &["status", "--porcelain"]),
            "",
            "{strategy:?} detached main worktree untouched"
        );
    }
}

#[test]
fn merge_a_branch_without_a_worktree_in_every_style() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, wt) = fixture();
        git(&r.root, &["worktree", "remove", wt.to_str().unwrap()]);
        let p = merge::preflight(&r.core(), None, "feat/x", "main").unwrap();
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        let res = merge::run(&r.core(), None, &plan(strategy)).unwrap();
        assert!(res.merged, "{strategy:?}: {:#?}", res.steps);
        assert_eq!(read(&r.root, "x2.txt"), "2\n", "{strategy:?}");
        let wts = git(&r.root, &["worktree", "list", "--porcelain"]);
        assert_eq!(
            wts.matches("worktree ").count(),
            1,
            "{strategy:?} temp worktree removed"
        );
    }
}

#[test]
fn a_remote_base_moves_the_local_branch() {
    let (r, wt) = fixture();
    git(&r.root, &["push", "-q", "origin", "main"]);
    let mut p = plan(Strategy::Squash);
    p.base = "origin/main".into();
    let res = merge::run(&r.core(), Some(&wt), &p).unwrap();
    assert!(res.merged, "{:#?}", res.steps);
    assert_eq!(subjects(&r, 1), ["Merge feat/x"]);
}

#[test]
fn an_empty_message_falls_back_to_a_default() {
    let (r, wt) = fixture();
    let mut p = plan(Strategy::MergeCommit);
    p.message = Some("   ".into());
    let res = merge::run(&r.core(), Some(&wt), &p).unwrap();
    assert!(res.merged);
    assert_eq!(subjects(&r, 1), ["Merge branch 'feat/x'"]);
}
