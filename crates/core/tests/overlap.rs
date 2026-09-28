//! Overlap warnings: right when two worktrees would collide, quiet otherwise.
mod common;
use common::*;
use pando_core::overlap;

fn pairs(r: &Repo) -> Vec<(String, String, Vec<String>)> {
    let name = |p: &std::path::Path| p.file_name().unwrap().to_string_lossy().into_owned();
    overlap::find(&r.core(), "main")
        .unwrap()
        .into_iter()
        .map(|o| (name(&o.a), name(&o.b), o.files))
        .collect()
}

#[test]
fn committed_changes_to_the_same_file_overlap() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    let b = add_worktree(&r, "feat/b", "wt-b");
    commit(&a, "shared.txt", "a\n");
    commit(&b, "shared.txt", "b\n");
    commit(&b, "only-b.txt", "b\n");
    assert_eq!(
        pairs(&r),
        [("wt-a".into(), "wt-b".into(), vec!["shared.txt".into()])]
    );
}

#[test]
fn uncommitted_work_counts_too() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    let b = add_worktree(&r, "feat/b", "wt-b");
    commit(&a, "README.md", "committed in a\n");
    write(&b, "README.md", "unsaved in b\n");
    assert_eq!(pairs(&r).len(), 1);
}

#[test]
fn different_files_dont_overlap() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    let b = add_worktree(&r, "feat/b", "wt-b");
    commit(&a, "a.txt", "a\n");
    commit(&b, "b.txt", "b\n");
    assert!(pairs(&r).is_empty());
}

#[test]
fn a_file_changed_and_changed_back_doesnt_count() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    let b = add_worktree(&r, "feat/b", "wt-b");
    commit(&a, "README.md", "temp\n");
    commit(&a, "README.md", "hello\n");
    commit(&b, "README.md", "b\n");
    assert!(pairs(&r).is_empty(), "{:?}", pairs(&r));
}

#[test]
fn changes_on_main_since_branching_dont_count() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    let b = add_worktree(&r, "feat/b", "wt-b");
    commit(&r.root, "moved.txt", "main\n");
    commit(&a, "x.txt", "a\n");
    commit(&b, "y.txt", "b\n");
    assert!(
        pairs(&r).is_empty(),
        "main's own commits aren't a worktree's changes"
    );
}

#[test]
fn the_main_worktree_counts_by_its_uncommitted_work() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    commit(&a, "README.md", "a\n");
    write(&r.root, "README.md", "unsaved on main\n");
    let p = pairs(&r);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].2, ["README.md"]);
}

#[test]
fn three_worktrees_give_each_pair() {
    let r = repo();
    for (b, f) in [("feat/a", "wt-a"), ("feat/b", "wt-b"), ("feat/c", "wt-c")] {
        let p = add_worktree(&r, b, f);
        commit(&p, "shared.txt", b);
    }
    assert_eq!(pairs(&r).len(), 3);
}

#[test]
fn odd_names_deletes_and_detached_worktrees() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    git(&a, &["rm", "-q", "README.md"]);
    git(&a, &["commit", "-q", "-m", "rm"]);
    commit(&a, "ünï côde.txt", "a\n");
    let d = r.sibling("wt-detached");
    git(
        &r.root,
        &["worktree", "add", "-q", "--detach", d.to_str().unwrap()],
    );
    write(&d, "README.md", "edit\n");
    write(&d, "ünï côde.txt", "d\n");
    let p = pairs(&r);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].2, ["README.md", "ünï côde.txt"]);
}

#[test]
fn missing_folders_and_empty_repos_are_fine() {
    let r = repo();
    let a = add_worktree(&r, "feat/a", "wt-a");
    commit(&a, "x.txt", "x\n");
    std::fs::remove_dir_all(&a).unwrap();
    assert!(pairs(&r).is_empty());
}
