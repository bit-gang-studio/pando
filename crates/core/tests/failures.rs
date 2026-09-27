//! When an action fails, nothing else may have changed.
mod common;
use common::*;
use pando_core::{
    branch, commit, index, merge, operation, stash, worktree, AddWorktree, Applied, MergePlan,
    Strategy,
};

#[test]
fn rename_onto_an_existing_branch_fails_and_keeps_both() {
    let r = repo();
    git(&r.root, &["branch", "a"]);
    commit(&r.root, "b.txt", "b\n");
    git(&r.root, &["branch", "b"]);
    let (a, b) = (r.tip("a"), r.tip("b"));
    assert!(branch::rename(&r.core(), "a", "b").is_err());
    assert_eq!((r.tip("a"), r.tip("b")), (a, b));
}

#[test]
fn invalid_branch_names_are_refused() {
    let r = repo();
    for bad in [
        "bad..name",
        "-dash",
        "has space",
        "end.lock",
        "a~b",
        "a^b",
        "a:b",
        "x/",
    ] {
        assert!(
            branch::create(&r.core(), bad, None).is_err(),
            "created {bad:?}"
        );
        assert!(
            branch::rename(&r.core(), "main", bad).is_err(),
            "renamed to {bad:?}"
        );
    }
    assert!(git_ok(&r.root, &["rev-parse", "--verify", "main"]));
}

#[test]
fn creating_an_existing_branch_fails_without_moving_it() {
    let r = repo();
    git(&r.root, &["branch", "a"]);
    let a = r.tip("a");
    commit(&r.root, "b.txt", "b\n");
    assert!(branch::create(&r.core(), "a", None).is_err());
    assert_eq!(r.tip("a"), a);
}

#[test]
fn adding_a_worktree_for_a_checked_out_branch_fails_cleanly() {
    let r = repo();
    let p = r.sibling("dup");
    let res = worktree::add(
        &r.core(),
        &AddWorktree {
            path: p.clone(),
            branch: "main".into(),
            base: None,
            create_branch: false,
        },
    );
    assert!(res.is_err());
    assert!(!p.exists(), "no folder left behind");
}

#[test]
fn adding_a_worktree_into_a_non_empty_folder_fails_and_leaves_it() {
    let r = repo();
    let p = r.sibling("taken");
    write(&p, "precious.txt", "mine\n");
    let res = worktree::add(
        &r.core(),
        &AddWorktree {
            path: p.clone(),
            branch: "feat/x".into(),
            base: None,
            create_branch: true,
        },
    );
    assert!(res.is_err());
    assert_eq!(read(&p, "precious.txt"), "mine\n");
    assert_eq!(worktree::list(&r.core()).unwrap().len(), 1);
}

#[test]
fn removing_a_dirty_worktree_without_force_fails_and_keeps_files() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    write(&wt, "work.txt", "unsaved\n");
    assert!(worktree::remove(&r.core(), &wt, false).is_err());
    assert_eq!(read(&wt, "work.txt"), "unsaved\n");
}

#[test]
fn a_locked_worktree_is_not_removed_even_with_force() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    worktree::lock(&r.core(), &wt, Some("on a USB drive")).unwrap();
    assert!(worktree::remove(&r.core(), &wt, true).is_err());
    assert!(wt.exists());
    worktree::unlock(&r.core(), &wt).unwrap();
    worktree::remove(&r.core(), &wt, true).unwrap();
    assert!(!wt.exists());
}

#[test]
fn moving_a_worktree_onto_an_existing_folder_fails() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    let other = r.sibling("other");
    write(&other, "keep.txt", "keep\n");
    assert!(worktree::move_to(&r.core(), &wt, &other).is_err());
    assert!(wt.exists());
    assert_eq!(read(&other, "keep.txt"), "keep\n");
}

#[test]
fn switching_main_with_conflicting_changes_fails_and_keeps_them() {
    let r = repo();
    git(&r.root, &["branch", "other"]);
    git(&r.root, &["switch", "-q", "other"]);
    commit(&r.root, "README.md", "other's version\n");
    git(&r.root, &["switch", "-q", "main"]);
    write(&r.root, "README.md", "my unsaved edit\n");
    assert!(branch::switch_in_main(&r.core(), "other").is_err());
    assert_eq!(git(&r.root, &["branch", "--show-current"]), "main");
    assert_eq!(read(&r.root, "README.md"), "my unsaved edit\n");
}

#[test]
fn pull_without_an_upstream_fails() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    assert!(branch::pull(&wt, false).is_err());
}

#[test]
fn pull_fast_forwards_and_a_conflicting_pull_can_be_aborted() {
    let r = repo();
    // Someone else pushes to main.
    let other = r.sibling("other-clone");
    git(
        &r.base,
        &["clone", "-q", r.origin.to_str().unwrap(), "other-clone"],
    );
    commit(&other, "README.md", "theirs\n");
    git(&other, &["push", "-q", "origin", "main"]);

    // Plain fast-forward.
    branch::fetch_all(&r.core()).unwrap();
    branch::pull(&r.root, false).unwrap();
    assert_eq!(read(&r.root, "README.md"), "theirs\n");

    // Now both sides change the same line.
    commit(&other, "README.md", "theirs again\n");
    git(&other, &["push", "-q", "origin", "main"]);
    commit(&r.root, "README.md", "mine\n");
    let mine = r.tip("main");
    let res = branch::pull(&r.root, false);
    assert!(res.is_err());
    let op = operation::detect(&r.root).unwrap().expect("paused merge");
    assert_eq!(op.conflicted, vec!["README.md"]);
    operation::abort(&r.root).unwrap();
    assert_eq!(r.tip("main"), mine);
    assert_eq!(read(&r.root, "README.md"), "mine\n");
    assert!(operation::detect(&r.root).unwrap().is_none());
}

#[test]
fn push_to_a_missing_remote_fails() {
    let r = repo();
    assert!(branch::push(&r.core(), "main", "nowhere", false).is_err());
}

#[test]
fn set_upstream_to_something_missing_fails() {
    let r = repo();
    git(&r.root, &["branch", "a"]);
    assert!(branch::set_upstream(&r.core(), "a", "origin/does-not-exist").is_err());
    assert!(!git_ok(
        &r.root,
        &["rev-parse", "--abbrev-ref", "a@{upstream}"]
    ));
}

#[test]
fn delete_on_origin_removes_only_that_branch() {
    let r = repo();
    git(&r.root, &["branch", "a"]);
    git(&r.root, &["push", "-q", "origin", "a"]);
    branch::delete_remote(&r.core(), "origin", "a").unwrap();
    assert!(!git_ok(
        &r.origin,
        &["rev-parse", "--verify", "refs/heads/a"]
    ));
    assert!(git_ok(
        &r.origin,
        &["rev-parse", "--verify", "refs/heads/main"]
    ));
    assert!(
        branch::delete_remote(&r.core(), "origin", "a").is_err(),
        "already gone"
    );
}

fn conflicting_commit(r: &Repo) -> String {
    git(&r.root, &["switch", "-q", "-c", "side"]);
    commit(&r.root, "README.md", "side\n");
    let id = r.tip("HEAD");
    git(&r.root, &["switch", "-q", "main"]);
    commit(&r.root, "README.md", "main\n");
    id
}

#[test]
fn conflicting_cherry_pick_pauses_and_abort_restores_everything() {
    let r = repo();
    let id = conflicting_commit(&r);
    let before = r.tip("main");
    assert_eq!(
        commit::cherry_pick(&r.core(), &r.root, &id).unwrap(),
        Applied::Paused
    );
    operation::abort(&r.root).unwrap();
    assert_eq!(r.tip("main"), before);
    assert_eq!(read(&r.root, "README.md"), "main\n");
    assert_eq!(git(&r.root, &["status", "--porcelain"]), "");
}

#[test]
fn cherry_pick_of_an_unknown_commit_fails_without_leaving_a_mess() {
    let r = repo();
    assert!(commit::cherry_pick(&r.core(), &r.root, "deadbeef").is_err());
    assert!(operation::detect(&r.root).unwrap().is_none());
}

#[test]
fn conflicting_revert_pauses_and_abort_restores_everything() {
    let r = repo();
    commit(&r.root, "README.md", "two\n");
    let target = r.tip("HEAD");
    commit(&r.root, "README.md", "three\n");
    let before = r.tip("main");
    assert_eq!(
        commit::revert(&r.core(), &r.root, &target).unwrap(),
        Applied::Paused
    );
    operation::abort(&r.root).unwrap();
    assert_eq!(r.tip("main"), before);
    assert_eq!(read(&r.root, "README.md"), "three\n");
}

#[test]
fn continue_is_refused_while_conflicts_remain() {
    let r = repo();
    let id = conflicting_commit(&r);
    commit::cherry_pick(&r.core(), &r.root, &id).unwrap();
    assert!(operation::continue_op(&r.root).is_err());
    assert!(
        operation::detect(&r.root).unwrap().is_some(),
        "still paused"
    );
}

#[test]
fn applying_a_stash_onto_conflicting_edits_keeps_the_stash_and_the_edits() {
    let r = repo();
    write(&r.root, "README.md", "stashed\n");
    stash::save(&r.root, Some("wip")).unwrap();
    write(&r.root, "README.md", "new unsaved edit\n");
    assert!(stash::apply(&r.root, 0).is_err());
    assert!(stash::pop(&r.root, 0).is_err());
    assert_eq!(read(&r.root, "README.md"), "new unsaved edit\n");
    assert_eq!(stash::list(&r.core()).unwrap().len(), 1, "stash kept");
}

#[test]
fn committing_with_nothing_staged_fails() {
    let r = repo();
    let before = r.tip("main");
    assert!(commit::create(&r.root, "nothing", false).is_err());
    assert_eq!(r.tip("main"), before);
}

#[test]
fn committing_with_an_empty_message_fails() {
    let r = repo();
    write(&r.root, "a.txt", "a\n");
    index::stage(&r.root, &["a.txt".into()]).unwrap();
    let before = r.tip("main");
    assert!(commit::create(&r.root, "   ", false).is_err());
    assert_eq!(r.tip("main"), before);
}

#[test]
fn a_held_index_lock_fails_changes_but_not_reads() {
    let r = repo();
    write(&r.root, "a.txt", "a\n");
    std::fs::write(r.root.join(".git/index.lock"), "").unwrap();
    let err = index::stage(&r.root, &["a.txt".into()])
        .unwrap_err()
        .to_string();
    assert!(err.contains("index.lock"), "{err}");
    // The repo page still loads.
    pando_core::overview::load(&r.core()).unwrap();
    pando_core::detail::load(&r.core(), &r.root).unwrap();
    std::fs::remove_file(r.root.join(".git/index.lock")).unwrap();
}

fn plan(strategy: Strategy) -> MergePlan {
    MergePlan {
        branch: "feat/x".into(),
        base: "main".into(),
        strategy,
        message: Some("merge feat/x".into()),
    }
}

/// feat/x and main both change README.md.
fn conflicting_branches() -> (Repo, std::path::PathBuf) {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "README.md", "branch\n");
    commit(&r.root, "README.md", "main\n");
    (r, wt)
}

#[test]
fn a_conflicting_merge_in_any_style_changes_nothing() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, wt) = conflicting_branches();
        let (main, feat) = (r.tip("main"), r.tip("feat/x"));
        let res = merge::run(&r.core(), Some(&wt), &plan(strategy)).unwrap();
        assert!(!res.merged, "{strategy:?}");
        assert!(
            res.steps.iter().any(|s| !s.ok),
            "{strategy:?} reports a failed step"
        );
        assert_eq!(r.tip("main"), main, "{strategy:?} main unchanged");
        assert_eq!(r.tip("feat/x"), feat, "{strategy:?} branch unchanged");
        assert!(
            operation::detect(&wt).unwrap().is_none(),
            "{strategy:?} nothing paused"
        );
        assert!(
            operation::detect(&r.root).unwrap().is_none(),
            "{strategy:?}"
        );
        assert_eq!(git(&wt, &["status", "--porcelain"]), "", "{strategy:?}");
        assert_eq!(git(&r.root, &["status", "--porcelain"]), "", "{strategy:?}");
    }
}

#[test]
fn a_conflicting_merge_with_the_base_not_checked_out_changes_nothing() {
    let (r, wt) = conflicting_branches();
    git(&r.root, &["switch", "-q", "--detach"]);
    let main = r.tip("main");
    let res = merge::run(&r.core(), Some(&wt), &plan(Strategy::MergeCommit)).unwrap();
    assert!(!res.merged);
    assert_eq!(r.tip("main"), main);
}

#[test]
fn a_conflicting_merge_of_a_branch_without_a_worktree_cleans_up() {
    let (r, wt) = conflicting_branches();
    git(&r.root, &["worktree", "remove", wt.to_str().unwrap()]);
    let main = r.tip("main");
    for strategy in [Strategy::Squash, Strategy::Rebase, Strategy::MergeCommit] {
        let res = merge::run(&r.core(), None, &plan(strategy)).unwrap();
        assert!(!res.merged, "{strategy:?}");
        assert_eq!(r.tip("main"), main, "{strategy:?}");
        assert_eq!(
            worktree::list(&r.core()).unwrap().len(),
            1,
            "{strategy:?} temp worktree gone"
        );
    }
    let stray: Vec<_> = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(&format!("pando-merge-{}-", std::process::id()))
                && e.file_name().to_string_lossy().ends_with("-feat-x")
        })
        .collect();
    assert!(stray.is_empty(), "temp folders left: {stray:?}");
}

#[test]
fn merging_a_branch_with_nothing_new_is_refused() {
    let r = repo();
    git(&r.root, &["branch", "feat/x"]);
    let p = merge::preflight(&r.core(), None, "feat/x", "main").unwrap();
    assert!(!p.problems.is_empty());
    let main = r.tip("main");
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let res = merge::run(&r.core(), None, &plan(strategy));
        assert!(!res.unwrap().merged, "{strategy:?} reported an empty merge");
        assert_eq!(
            git(&r.root, &["rev-list", "--count", "main"]),
            git(&r.root, &["rev-list", "--count", &main]),
            "{strategy:?} added a commit"
        );
    }
}

#[test]
fn preflight_blocks_a_dirty_branch_or_a_dirty_base() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "x.txt", "x\n");
    write(&wt, "x.txt", "dirty\n");
    let p = merge::preflight(&r.core(), Some(&wt), "feat/x", "main").unwrap();
    assert!(
        p.problems.iter().any(|m| m.contains("this worktree")),
        "{:?}",
        p.problems
    );

    git(&wt, &["checkout", "--", "x.txt"]);
    write(&r.root, "README.md", "dirty main\n");
    let p = merge::preflight(&r.core(), Some(&wt), "feat/x", "main").unwrap();
    assert!(
        p.problems.iter().any(|m| m.contains("main")),
        "{:?}",
        p.problems
    );
}
