//! Things done to a repo behind Pando's back: in a terminal or in Finder.
mod common;
use common::*;
use pando_core::{detail, merge, overview, status, worktree};

#[test]
fn a_worktree_moved_by_hand_is_missing_then_repair_reconnects_it() {
    let r = repo();
    let old = add_worktree(&r, "feat/x", "work-feat-x");
    write(&old, "wip.txt", "precious\n");
    let new = r.base.join("moved here ü");
    std::fs::rename(&old, &new).unwrap();
    let core = r.core();

    let before = worktree::list(&core).unwrap();
    let w = before
        .iter()
        .find(|w| w.branch.as_deref() == Some("feat/x"))
        .unwrap();
    assert!(
        w.prunable.is_some(),
        "git should call the old folder missing"
    );

    worktree::repair(&core, &new).unwrap();
    let after = worktree::list(&core).unwrap();
    let w = after
        .iter()
        .find(|w| w.branch.as_deref() == Some("feat/x"))
        .unwrap();
    assert_eq!(w.path, new);
    assert!(w.prunable.is_none());
    assert_eq!(
        read(&new, "wip.txt"),
        "precious\n",
        "uncommitted work untouched"
    );
    // Git works inside it again, and Pando sees its change.
    assert!(git_ok(&new, &["status"]));
    let o = overview::load(&core).unwrap();
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/x")
        .unwrap();
    assert_eq!(row.status.as_ref().unwrap().untracked, 1);
}

#[test]
fn repair_refuses_folders_that_are_not_this_repos_worktree() {
    let r = repo();
    let other = repo_named("other");
    let theirs = add_worktree(&other, "feat/theirs", "other-feat-theirs");
    let plain = r.base.join("plain");
    std::fs::create_dir(&plain).unwrap();
    let core = r.core();
    let before = worktree::list(&core).unwrap();
    for bad in [&theirs, &plain, &r.base.join("nope"), &r.root, &other.root] {
        let e = worktree::repair(&core, bad).unwrap_err().to_string();
        assert!(
            e.contains("isn't a worktree of this repository"),
            "{}: {e}",
            bad.display()
        );
    }
    assert_eq!(worktree::list(&core).unwrap(), before);
    // The other repo's worktree still belongs to the other repo.
    assert!(worktree::list(&other.core())
        .unwrap()
        .iter()
        .any(|w| w.path == theirs && w.prunable.is_none()));
}

#[test]
fn repair_on_a_worktree_that_never_moved_changes_nothing() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    let core = r.core();
    let before = worktree::list(&core).unwrap();
    worktree::repair(&core, &wt).unwrap();
    assert_eq!(worktree::list(&core).unwrap(), before);
}

#[test]
fn a_commit_checked_out_in_a_terminal_shows_as_detached() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    git(&wt, &["switch", "-q", "--detach"]);
    let o = overview::load(&r.core()).unwrap();
    assert!(o
        .detached
        .iter()
        .any(|d| d.worktree.path == wt && d.worktree.detached));
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/x")
        .unwrap();
    assert!(row.worktree.is_none(), "feat/x has no worktree now");
}

#[test]
fn a_branch_renamed_in_a_terminal_keeps_its_worktree() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    git(&r.root, &["branch", "-m", "feat/x", "feat/renamed"]);
    let o = overview::load(&r.core()).unwrap();
    assert!(!o.branches.iter().any(|b| b.branch.name == "feat/x"));
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/renamed")
        .unwrap();
    assert_eq!(row.worktree.as_ref().unwrap().path, wt);
}

#[test]
fn a_branch_switched_in_a_terminal_moves_the_worktree_to_that_branch() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    git(&wt, &["switch", "-q", "-c", "feat/y"]);
    let o = overview::load(&r.core()).unwrap();
    let y = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/y")
        .unwrap();
    assert_eq!(y.worktree.as_ref().unwrap().path, wt);
    assert!(o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/x")
        .unwrap()
        .worktree
        .is_none());
}

#[test]
fn a_worktree_whose_folder_is_gone_says_so_everywhere() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    std::fs::remove_dir_all(&wt).unwrap();
    let core = r.core();
    let missing = |e: String| {
        assert!(
            e.contains("is missing. It may have been moved or deleted."),
            "{e}"
        );
        assert!(e.contains("work-feat-x"), "{e}");
        assert!(!e.contains("os error"), "{e}");
    };
    missing(detail::load(&core, &wt).unwrap_err().to_string());
    missing(status::files(&wt).unwrap_err().to_string());
    missing(
        merge::preflight(&core, Some(&wt), "feat/x", "main")
            .unwrap_err()
            .to_string(),
    );
    // The rest of the repo still loads, with the worktree marked.
    let o = overview::load(&core).unwrap();
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/x")
        .unwrap();
    assert!(row.worktree.as_ref().unwrap().prunable.is_some());
    assert!(row.status.is_none());
}
