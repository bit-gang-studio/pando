//! Every Undo puts things back exactly; "merged" is right for every way of merging.
mod common;
use common::*;
use pando_core::{backup, index, overview, stash, worktree};

#[test]
fn undo_discard() {
    let r = repo();
    write(&r.root, "README.md", "edit\n");
    let snap = index::discard(&r.root, &["README.md".into()], &[])
        .unwrap()
        .unwrap();
    backup::restore_files(&r.core(), &snap, &r.root).unwrap();
    assert_eq!(read(&r.root, "README.md"), "edit\n");
    assert!(
        index::discard(&r.root, &[], &[]).unwrap().is_none(),
        "nothing to save"
    );
}

#[test]
fn undo_drop_stash() {
    let r = repo();
    write(&r.root, "README.md", "wip\n");
    stash::save(&r.root, Some("wip")).unwrap();
    let kept = stash::drop(&r.core(), 0).unwrap();
    backup::restore_files(&r.core(), &kept, &r.root).unwrap();
    assert_eq!(read(&r.root, "README.md"), "wip\n");
}

#[test]
fn undo_drop_puts_the_stash_back_in_the_list() {
    let r = repo();
    write(&r.root, "README.md", "wip\n");
    stash::save(&r.root, Some("my wip")).unwrap();
    let kept = stash::drop(&r.core(), 0).unwrap();
    assert!(stash::list(&r.core()).unwrap().is_empty());
    stash::restore(&r.core(), &kept, "my wip").unwrap();
    let list = stash::list(&r.core()).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].message.contains("my wip"));
    assert_eq!(
        read(&r.root, "README.md"),
        "hello\n",
        "files untouched until you apply it"
    );
    assert!(stash::restore(&r.core(), "refs/heads/main", "x").is_err());
}

#[test]
fn undo_remove_puts_the_worktree_back_where_it_was() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "x.txt", "x\n");
    let removed = worktree::remove(&r.core(), &wt, false).unwrap();
    assert!(!wt.exists());
    assert!(removed.snapshot.is_none());
    worktree::undo_remove(&r.core(), &removed).unwrap();
    assert_eq!(read(&wt, "x.txt"), "x\n");
    assert_eq!(git(&wt, &["branch", "--show-current"]), "feat/x");
}

#[test]
fn undo_forced_remove_brings_back_uncommitted_changes() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    write(&wt, "README.md", "unsaved edit\n");
    write(&wt, "new.txt", "new\n");
    let removed = worktree::remove(&r.core(), &wt, true).unwrap();
    worktree::undo_remove(&r.core(), &removed).unwrap();
    assert_eq!(read(&wt, "README.md"), "unsaved edit\n");
    assert_eq!(read(&wt, "new.txt"), "new\n");
}

#[test]
fn undo_remove_of_a_detached_worktree() {
    let r = repo();
    let p = r.sibling("det");
    git(
        &r.root,
        &["worktree", "add", "-q", "--detach", p.to_str().unwrap()],
    );
    let head = git(&p, &["rev-parse", "HEAD"]);
    let removed = worktree::remove(&r.core(), &p, false).unwrap();
    worktree::undo_remove(&r.core(), &removed).unwrap();
    assert_eq!(git(&p, &["rev-parse", "HEAD"]), head);
}

#[test]
fn undo_remove_refuses_if_the_folder_is_back() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    let removed = worktree::remove(&r.core(), &wt, false).unwrap();
    write(&wt, "someone-else.txt", "mine\n");
    assert!(worktree::undo_remove(&r.core(), &removed).is_err());
    assert_eq!(read(&wt, "someone-else.txt"), "mine\n");
}

fn merged(r: &Repo, branch: &str) -> bool {
    overview::load(&r.core())
        .unwrap()
        .branches
        .iter()
        .find(|b| b.branch.name == branch)
        .unwrap()
        .merged
}

#[test]
fn merged_covers_plain_squash_and_rebase_merges() {
    // Plain merge.
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "x.txt", "x\n");
    assert!(!merged(&r, "feat/x"), "not merged yet");
    git(&r.root, &["merge", "-q", "--no-ff", "-m", "m", "feat/x"]);
    assert!(merged(&r, "feat/x"), "plain merge");

    // Squash merge: the branch's own commits never reach main.
    let r = repo();
    let wt = add_worktree(&r, "feat/y", "wt");
    commit(&wt, "y1.txt", "1\n");
    commit(&wt, "y2.txt", "2\n");
    git(&r.root, &["merge", "-q", "--squash", "feat/y"]);
    git(&r.root, &["commit", "-q", "-m", "squash"]);
    commit(&r.root, "later.txt", "main moved on\n");
    assert!(merged(&r, "feat/y"), "squash merge");

    // Rebase merge: same changes, different commits.
    let r = repo();
    let wt = add_worktree(&r, "feat/z", "wt");
    commit(&wt, "z.txt", "z\n");
    let tip = git(&wt, &["rev-parse", "HEAD"]);
    // Main has moved on, as it has by the time a PR is rebased in.
    commit(&r.root, "other.txt", "other work\n");
    git(&r.root, &["cherry-pick", &tip]);
    assert!(merged(&r, "feat/z"), "rebase merge");
}

#[test]
fn not_merged_when_fresh_partly_merged_or_main() {
    let r = repo();
    add_worktree(&r, "fresh", "wt-fresh");
    assert!(!merged(&r, "fresh"), "a brand-new branch isn't 'merged'");

    let wt = add_worktree(&r, "feat/part", "wt-part");
    commit(&wt, "a.txt", "a\n");
    let first = git(&wt, &["rev-parse", "HEAD"]);
    commit(&wt, "b.txt", "b\n");
    git(&r.root, &["cherry-pick", &first]);
    assert!(!merged(&r, "feat/part"), "b.txt still isn't in main");

    assert!(!merged(&r, "main"));
}

#[test]
fn merged_is_skipped_on_the_quick_load() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "x.txt", "x\n");
    git(&r.root, &["merge", "-q", "--no-ff", "-m", "m", "feat/x"]);
    let q = overview::load_quick(&r.core()).unwrap();
    assert!(q.branches.iter().all(|b| !b.merged));
}
