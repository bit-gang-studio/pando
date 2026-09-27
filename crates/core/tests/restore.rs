//! Getting work back: restore from backups and snapshots.
mod common;
use common::*;
use pando_core::backup::{self, Kind};
use pando_core::{branch, index, stash, worktree};

#[test]
fn a_deleted_branch_comes_back() {
    let r = repo();
    git(&r.root, &["branch", "gone"]);
    let tip = r.tip("gone");
    branch::delete(&r.core(), "gone", true).unwrap();

    let list = backup::list(&r.core()).unwrap();
    let b = list
        .iter()
        .find(|b| b.branch.as_deref() == Some("gone"))
        .unwrap();
    assert_eq!(b.kind, Kind::Branch);
    assert!(!b.branch_exists);
    assert!(b.time > 0);
    backup::restore_branch(&r.core(), &b.refname).unwrap();
    assert_eq!(r.tip("gone"), tip);
}

#[test]
fn backups_that_match_the_branch_now_are_not_offered() {
    let r = repo();
    git(&r.root, &["branch", "same"]);
    backup::write(&r.core(), "same").unwrap();
    assert!(backup::list(&r.core())
        .unwrap()
        .iter()
        .all(|b| b.branch.as_deref() != Some("same")));
}

#[test]
fn restoring_a_moved_branch_can_itself_be_undone() {
    let r = repo();
    git(&r.root, &["branch", "b"]);
    let old = r.tip("b");
    backup::write(&r.core(), "b").unwrap();
    git(&r.root, &["switch", "-q", "b"]);
    commit(&r.root, "x.txt", "x\n");
    git(&r.root, &["switch", "-q", "main"]);
    let new = r.tip("b");

    backup::restore_branch(&r.core(), "refs/pando/backup/b").unwrap();
    assert_eq!(r.tip("b"), old);
    // The tip we just replaced is now the backup: restore again flips back.
    backup::restore_branch(&r.core(), "refs/pando/backup/b").unwrap();
    assert_eq!(r.tip("b"), new);
}

#[test]
fn restoring_a_checked_out_branch_is_refused() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    let before = r.tip("feat/x");
    backup::write(&r.core(), "feat/x").unwrap();
    commit(&wt, "y.txt", "y\n");
    let err = backup::restore_branch(&r.core(), "refs/pando/backup/feat/x")
        .unwrap_err()
        .to_string();
    assert!(err.contains("checked out"), "{err}");
    assert_ne!(r.tip("feat/x"), before, "unchanged");
}

#[test]
fn discarded_files_come_back_and_what_was_there_is_kept() {
    let r = repo();
    write(&r.root, "README.md", "my edit\n");
    write(&r.root, "new file ü.txt", "new\n");
    index::discard(&r.root, &["README.md".into()], &["new file ü.txt".into()]).unwrap();

    // Meanwhile README.md is edited again. Restoring must not lose this either.
    write(&r.root, "README.md", "second edit\n");
    let b = backup::list(&r.core())
        .unwrap()
        .into_iter()
        .find(|b| b.kind == Kind::Discard)
        .unwrap();
    let mut files = b.files.clone();
    files.sort();
    assert_eq!(files, ["README.md", "new file ü.txt"]);
    backup::restore_files(&r.core(), &b.refname, &r.root).unwrap();

    assert_eq!(read(&r.root, "README.md"), "my edit\n");
    assert_eq!(read(&r.root, "new file ü.txt"), "new\n");
    let saved = backup::list(&r.core())
        .unwrap()
        .into_iter()
        .find(|b| b.kind == Kind::Restore)
        .unwrap();
    assert_eq!(
        git(&r.root, &["show", &format!("{}:README.md", saved.id)]),
        "second edit"
    );
}

#[test]
fn a_force_removed_worktree_can_be_restored_into_a_new_one() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    write(&wt, "work.txt", "unsaved\n");
    worktree::remove(&r.core(), &wt, true).unwrap();
    let b = backup::list(&r.core())
        .unwrap()
        .into_iter()
        .find(|b| b.kind == Kind::RemoveWorktree)
        .unwrap();
    assert_eq!(b.files, ["work.txt"]);

    let again = add_worktree(&r, "feat/y", "wt2");
    backup::restore_files(&r.core(), &b.refname, &again).unwrap();
    assert_eq!(read(&again, "work.txt"), "unsaved\n");
}

#[test]
fn a_dropped_stash_can_be_applied_again() {
    let r = repo();
    write(&r.root, "README.md", "stashed\n");
    write(&r.root, "untracked.txt", "u\n");
    stash::save(&r.root, Some("wip")).unwrap();
    stash::drop(&r.core(), 0).unwrap();
    let b = backup::list(&r.core())
        .unwrap()
        .into_iter()
        .find(|b| b.kind == Kind::Stash)
        .unwrap();
    assert!(b.files.contains(&"README.md".to_string()), "{:?}", b.files);
    backup::restore_files(&r.core(), &b.refname, &r.root).unwrap();
    assert_eq!(read(&r.root, "README.md"), "stashed\n");
    assert_eq!(read(&r.root, "untracked.txt"), "u\n");
}

#[test]
fn only_pando_refs_can_be_restored_or_deleted() {
    let r = repo();
    assert!(backup::delete(&r.core(), "refs/heads/main").is_err());
    assert!(backup::restore_branch(&r.core(), "refs/heads/main").is_err());
    assert!(backup::restore_files(&r.core(), "refs/tags/x", &r.root).is_err());
    assert!(git_ok(&r.root, &["rev-parse", "--verify", "main"]));
}

#[test]
fn delete_removes_a_backup_for_good() {
    let r = repo();
    git(&r.root, &["branch", "gone"]);
    branch::delete(&r.core(), "gone", true).unwrap();
    backup::delete(&r.core(), "refs/pando/backup/gone").unwrap();
    assert!(backup::list(&r.core()).unwrap().is_empty());
    assert!(backup::restore_branch(&r.core(), "refs/pando/backup/gone").is_err());
}

#[test]
fn newest_first() {
    let r = repo();
    for i in 0..3 {
        write(&r.root, "README.md", &format!("edit {i}\n"));
        index::discard(&r.root, &["README.md".into()], &[]).unwrap();
    }
    let times: Vec<i64> = backup::list(&r.core())
        .unwrap()
        .iter()
        .map(|b| b.time)
        .collect();
    assert_eq!(times.len(), 3);
    assert!(times.windows(2).all(|w| w[0] >= w[1]), "{times:?}");
}
