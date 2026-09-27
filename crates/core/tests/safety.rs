//! Every change that can lose work must leave a way back.
mod common;
use common::*;
use pando_core::{branch, index, merge, stash, worktree, MergePlan, Strategy};

fn snapshot_refs(r: &Repo, what: &str) -> Vec<String> {
    pando_refs(r)
        .into_iter()
        .filter(|n| n.starts_with(&format!("refs/pando/snapshots/{what}/")))
        .collect()
}

#[test]
fn discard_keeps_a_copy_of_edited_and_new_files() {
    let r = repo();
    write(&r.root, "README.md", "my unsaved edit\n");
    write(&r.root, "new dir/new file.txt", "brand new\n");
    index::discard(
        &r.root,
        &["README.md".into()],
        &["new dir/new file.txt".into()],
    )
    .unwrap();

    assert_eq!(read(&r.root, "README.md"), "hello\n", "edit discarded");
    assert!(
        !r.root.join("new dir/new file.txt").exists(),
        "new file deleted"
    );
    let snaps = snapshot_refs(&r, "discard");
    assert_eq!(snaps.len(), 1);
    let s = &snaps[0];
    assert_eq!(
        git(&r.root, &["show", &format!("{s}:README.md")]),
        "my unsaved edit"
    );
    assert_eq!(
        git(&r.root, &["show", &format!("{s}:new dir/new file.txt")]),
        "brand new"
    );
}

#[test]
fn discard_leaves_the_real_index_alone() {
    let r = repo();
    write(&r.root, "staged.txt", "staged\n");
    git(&r.root, &["add", "staged.txt"]);
    write(&r.root, "README.md", "edit\n");
    let before = git(&r.root, &["diff", "--cached", "--name-only"]);
    index::discard(&r.root, &["README.md".into()], &[]).unwrap();
    assert_eq!(git(&r.root, &["diff", "--cached", "--name-only"]), before);
    assert_eq!(before, "staged.txt");
    let leftovers: Vec<_> = std::fs::read_dir(r.root.join(".git"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("pando-snapshot"))
        .collect();
    assert!(leftovers.is_empty(), "temporary index removed");
}

#[test]
fn discard_in_a_repo_with_no_commits() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    write(&root, "a.txt", "only copy\n");
    index::discard(&root, &[], &["a.txt".into()]).unwrap();
    assert!(!root.join("a.txt").exists());
    let snap = git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/pando/snapshots/",
        ],
    );
    assert_eq!(git(&root, &["show", &format!("{snap}:a.txt")]), "only copy");
}

#[test]
fn discard_of_a_missing_path_fails_and_changes_nothing() {
    let r = repo();
    write(&r.root, "README.md", "keep me\n");
    assert!(index::discard(&r.root, &["nope.txt".into()], &[]).is_err());
    assert_eq!(read(&r.root, "README.md"), "keep me\n");
}

#[test]
fn force_removing_a_dirty_worktree_keeps_its_changes() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "a.txt", "committed\n");
    write(&wt, "a.txt", "uncommitted edit\n");
    write(&wt, "untracked.txt", "new\n");
    let tip = git(&wt, &["rev-parse", "HEAD"]);

    worktree::remove(&r.core(), &wt, true).unwrap();

    assert!(!wt.exists());
    assert_eq!(r.tip("feat/x"), tip, "branch kept");
    let snaps = snapshot_refs(&r, "remove-worktree");
    assert_eq!(snaps.len(), 1);
    assert_eq!(
        git(&r.root, &["show", &format!("{}:a.txt", snaps[0])]),
        "uncommitted edit"
    );
    assert_eq!(
        git(&r.root, &["show", &format!("{}:untracked.txt", snaps[0])]),
        "new"
    );
}

#[test]
fn removing_a_clean_worktree_makes_no_snapshot() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    worktree::remove(&r.core(), &wt, true).unwrap();
    assert!(snapshot_refs(&r, "remove-worktree").is_empty());
}

#[test]
fn dropped_stash_can_be_recovered() {
    let r = repo();
    write(&r.root, "README.md", "stashed work\n");
    stash::save(&r.root, Some("wip")).unwrap();
    let id = git(&r.root, &["rev-parse", "stash@{0}"]);
    stash::drop(&r.core(), 0).unwrap();

    assert!(stash::list(&r.core()).unwrap().is_empty());
    let snaps = snapshot_refs(&r, "stash");
    assert_eq!(snaps.len(), 1);
    assert_eq!(r.tip(&snaps[0]), id);
    assert_eq!(
        git(&r.root, &["show", &format!("{}:README.md", snaps[0])]),
        "stashed work"
    );
}

#[test]
fn dropping_a_stash_that_does_not_exist_fails() {
    let r = repo();
    assert!(stash::drop(&r.core(), 3).is_err());
    assert!(snapshot_refs(&r, "stash").is_empty());
}

#[test]
fn deleted_branch_is_backed_up_and_older_backups_survive() {
    let r = repo();
    git(&r.root, &["branch", "gone"]);
    commit(&r.root, "b.txt", "b\n");
    let first = r.tip("gone");
    branch::delete(&r.core(), "gone", true).unwrap();
    assert_eq!(r.tip("refs/pando/backup/gone"), first);

    // Same name again, different tip: both backups are in the reflog.
    git(&r.root, &["branch", "gone"]);
    let second = r.tip("gone");
    assert_ne!(first, second);
    branch::delete(&r.core(), "gone", true).unwrap();
    assert_eq!(r.tip("refs/pando/backup/gone"), second);
    let log = git(
        &r.root,
        &["reflog", "show", "--format=%H", "refs/pando/backup/gone"],
    );
    assert!(log.contains(&first), "older backup still reachable: {log}");
}

fn merge_fixture() -> (Repo, std::path::PathBuf) {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    commit(&wt, "x.txt", "x\n");
    commit(&r.root, "m.txt", "m\n");
    (r, wt)
}

#[test]
fn every_merge_style_backs_up_the_base_before_moving_it() {
    for strategy in [Strategy::MergeCommit, Strategy::Squash, Strategy::Rebase] {
        let (r, wt) = merge_fixture();
        let main_before = r.tip("main");
        let branch_before = r.tip("feat/x");
        let res = merge::run(
            &r.core(),
            Some(&wt),
            &MergePlan {
                branch: "feat/x".into(),
                base: "main".into(),
                strategy,
                message: Some("merge".into()),
            },
        )
        .unwrap();
        assert!(res.merged, "{strategy:?}: {:#?}", res.steps);
        assert_ne!(r.tip("main"), main_before, "{strategy:?} moved main");
        assert_eq!(r.tip("refs/pando/backup/main"), main_before, "{strategy:?}");
        assert_eq!(
            r.tip("refs/pando/backup/feat/x"),
            branch_before,
            "{strategy:?}"
        );
    }
}

#[test]
fn snapshots_and_backups_are_never_pushed() {
    let r = repo();
    write(&r.root, "README.md", "edit\n");
    index::discard(&r.root, &["README.md".into()], &[]).unwrap();
    git(&r.root, &["branch", "tmp"]);
    branch::delete(&r.core(), "tmp", true).unwrap();
    branch::push(&r.core(), "main", "origin", false).unwrap();
    let remote_refs = git(&r.origin, &["for-each-ref", "--format=%(refname)"]);
    assert!(!remote_refs.contains("refs/pando"), "{remote_refs}");
}
