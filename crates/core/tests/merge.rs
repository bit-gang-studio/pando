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

/// A base branch with a slash in its name ("release/1.0") is a local branch,
/// not a branch "1.0" on a remote called "release".
fn onto_slashed_base() -> (Repo, std::path::PathBuf, std::path::PathBuf) {
    let r = repo();
    let base = add_worktree(&r, "release/1.0", "wt-release");
    commit(&base, "rel.txt", "r\n");
    let wt = r.base.join("wt-fix");
    git(
        &r.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "fix/thing",
            wt.to_str().unwrap(),
            "release/1.0",
        ],
    );
    commit(&wt, "fix.txt", "f\n");
    (r, base, wt)
}

#[test]
fn merging_into_a_base_with_a_slash_in_its_name() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, base, wt) = onto_slashed_base();
        let core = r.core();
        let p = merge::preflight(&core, Some(&wt), "fix/thing", "release/1.0").unwrap();
        assert_eq!(p.base_local, "release/1.0");
        assert_eq!(p.base_checked_out_in.as_deref(), Some(base.as_path()));
        assert!(p.problems.is_empty(), "{strategy:?}: {:?}", p.problems);
        let out = merge::run(
            &core,
            Some(&wt),
            &MergePlan {
                branch: "fix/thing".into(),
                base: "release/1.0".into(),
                strategy,
                message: Some("Merge fix".into()),
            },
        )
        .unwrap();
        assert!(out.merged, "{strategy:?}: {:?}", out.steps);
        assert_eq!(
            read(&base, "fix.txt"),
            "f\n",
            "{strategy:?}: the base's worktree has the file"
        );
        assert!(
            !git_ok(&r.root, &["rev-parse", "--verify", "-q", "refs/heads/1.0"]),
            "no branch named 1.0 appeared"
        );
        assert_eq!(
            r.tip("main"),
            r.tip("origin/main"),
            "main was never touched"
        );
    }
}

#[test]
fn a_conflict_says_which_branches_clash_and_leaves_both_alone() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, base, wt) = onto_slashed_base();
        commit(&base, "same.txt", "base side\n");
        commit(&wt, "same.txt", "fix side\n");
        let (a, b) = (r.tip("release/1.0"), r.tip("fix/thing"));
        let out = merge::run(
            &r.core(),
            Some(&wt),
            &MergePlan {
                branch: "fix/thing".into(),
                base: "release/1.0".into(),
                strategy,
                message: Some("m".into()),
            },
        )
        .unwrap();
        assert!(!out.merged);
        let said = &out.steps.iter().find(|s| !s.ok).unwrap().output;
        assert!(
            said.contains("fix/thing and release/1.0 change the same lines"),
            "{said}"
        );
        assert!(said.contains("Use Sync with release/1.0"), "{said}");
        // Git's own progress text stays out of it.
        assert!(
            !said.contains("Rebasing (")
                && !said.contains("could not apply")
                && !said.contains('\r'),
            "{said}"
        );
        assert_eq!(
            (r.tip("release/1.0"), r.tip("fix/thing")),
            (a.clone(), b.clone())
        );
        assert_eq!(git(&wt, &["status", "--porcelain"]), "");
    }
}

#[test]
fn a_conflict_with_the_base_not_checked_out_says_the_same_and_moves_nothing() {
    let (r, base, wt) = onto_slashed_base();
    commit(&base, "same.txt", "base side\n");
    commit(&wt, "same.txt", "fix side\n");
    pando_core::worktree::remove(&r.core(), &base, false).unwrap();
    let (a, b) = (r.tip("release/1.0"), r.tip("fix/thing"));
    let got = merge::run(
        &r.core(),
        Some(&wt),
        &MergePlan {
            branch: "fix/thing".into(),
            base: "release/1.0".into(),
            strategy: Strategy::MergeCommit,
            message: Some("m".into()),
        },
    );
    let said = match got {
        Ok(out) => {
            assert!(!out.merged);
            out.steps.iter().find(|s| !s.ok).unwrap().output.clone()
        }
        Err(e) => e.to_string(),
    };
    assert!(
        said.contains("fix/thing and release/1.0 change the same lines"),
        "{said}"
    );
    assert_eq!((r.tip("release/1.0"), r.tip("fix/thing")), (a, b));
}
