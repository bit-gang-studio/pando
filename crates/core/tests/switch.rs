//! Switching the branch inside a worktree. Git's rule: one branch can be
//! checked out in one worktree at a time.
mod common;
use common::*;
use pando_core::{branch, overview, sync};

/// main, plus feat/a in its own worktree, plus free branches feat/b and feat/c.
fn fixture() -> (Repo, std::path::PathBuf) {
    let r = repo();
    let wt = add_worktree(&r, "feat/a", "work-feat-a");
    commit(&wt, "a.txt", "a\n");
    git(&r.root, &["branch", "feat/b"]);
    git(&r.root, &["branch", "feat/c", "feat/a"]);
    (r, wt)
}
fn on(dir: &std::path::Path) -> String {
    git(dir, &["branch", "--show-current"])
}

#[test]
fn a_linked_worktree_switches_and_the_old_branch_stays() {
    let (r, wt) = fixture();
    let core = r.core();
    assert_eq!(
        branch::switch_in(&core, &wt, "feat/b").unwrap().as_deref(),
        Some("feat/a")
    );
    assert_eq!(on(&wt), "feat/b");
    assert!(!wt.join("a.txt").exists(), "feat/b doesn't have a.txt");
    assert_eq!(on(&r.root), "main", "the main worktree is untouched");
    // feat/a still exists and is free again.
    let o = overview::load(&core).unwrap();
    let a = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/a")
        .unwrap();
    assert!(a.worktree.is_none());
    assert_eq!(
        o.branches
            .iter()
            .find(|b| b.branch.name == "feat/b")
            .unwrap()
            .worktree
            .as_ref()
            .unwrap()
            .path,
        wt
    );
    // Back again, which is what Undo does.
    assert_eq!(
        branch::switch_in(&core, &wt, "feat/a").unwrap().as_deref(),
        Some("feat/b")
    );
    assert_eq!(read(&wt, "a.txt"), "a\n");
    // Switching to the branch it's already on changes nothing.
    assert_eq!(
        branch::switch_in(&core, &wt, "feat/a").unwrap().as_deref(),
        Some("feat/a")
    );
}

#[test]
fn a_branch_in_another_worktree_is_refused_by_name() {
    let (r, wt) = fixture();
    let core = r.core();
    let e = branch::switch_in(&core, &wt, "main")
        .unwrap_err()
        .to_string();
    assert_eq!(
        e,
        "main is checked out in work. A branch can be in one worktree at a time."
    );
    let e = branch::switch_in(&core, &r.root, "feat/a")
        .unwrap_err()
        .to_string();
    assert_eq!(
        e,
        "feat/a is checked out in work-feat-a. A branch can be in one worktree at a time."
    );
    assert!(branch::switch_in_main(&core, "feat/a").is_err());
    assert_eq!(
        (on(&wt), on(&r.root)),
        ("feat/a".to_string(), "main".to_string())
    );
}

#[test]
fn uncommitted_changes_come_along_unless_they_would_be_lost() {
    let (r, wt) = fixture();
    let core = r.core();
    // A new file and an edit to a file both branches share: they come along.
    write(&wt, "new.txt", "untracked\n");
    write(&wt, "README.md", "edited\n");
    branch::switch_in(&core, &wt, "feat/c").unwrap();
    assert_eq!(
        (
            read(&wt, "new.txt").as_str(),
            read(&wt, "README.md").as_str()
        ),
        ("untracked\n", "edited\n")
    );
    // An edit to a file the other branch doesn't have would be lost: refused.
    write(&wt, "a.txt", "precious edit\n");
    let e = branch::switch_in(&core, &wt, "feat/b")
        .unwrap_err()
        .to_string();
    assert_eq!(
        e,
        "Your uncommitted changes to a.txt would be lost. Commit or stash them first."
    );
    assert_eq!(on(&wt), "feat/c");
    assert_eq!(read(&wt, "a.txt"), "precious edit\n");
    assert_eq!(read(&wt, "new.txt"), "untracked\n");
}

#[test]
fn many_files_at_risk_are_counted_not_listed() {
    let r = repo();
    let wt = add_worktree(&r, "feat/a", "work-feat-a");
    for i in 0..5 {
        write(&wt, &format!("f{i}.txt"), "x\n");
    }
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-q", "-m", "five files"]);
    git(&r.root, &["branch", "feat/b"]);
    for i in 0..5 {
        write(&wt, &format!("f{i}.txt"), "edited\n");
    }
    let e = branch::switch_in(&r.core(), &wt, "feat/b")
        .unwrap_err()
        .to_string();
    assert_eq!(e, "Your uncommitted changes to f0.txt and 4 more files would be lost. Commit or stash them first.");
}

#[test]
fn odd_requests_are_refused_plainly() {
    let (r, wt) = fixture();
    let core = r.core();
    for bad in [
        "nope",
        "",
        "-f",
        "--detach",
        "origin/main",
        "HEAD",
        "main~1",
    ] {
        let e = branch::switch_in(&core, &wt, bad).unwrap_err().to_string();
        assert!(e.starts_with("No local branch named"), "{bad:?}: {e}");
    }
    let e = branch::switch_in(&core, &r.base, "feat/b")
        .unwrap_err()
        .to_string();
    assert!(e.contains("isn't a worktree of this repository"), "{e}");
    assert_eq!(on(&wt), "feat/a");
}

#[test]
fn a_detached_worktree_can_take_a_branch_and_a_paused_rebase_blocks_it() {
    let (r, wt) = fixture();
    let core = r.core();
    git(&wt, &["switch", "-q", "--detach"]);
    assert_eq!(
        branch::switch_in(&core, &wt, "feat/b").unwrap(),
        None,
        "it had no branch before"
    );
    assert_eq!(on(&wt), "feat/b");
    // Pause a rebase in it: main and feat/b both change the same file.
    commit(&wt, "clash.txt", "from b\n");
    commit(&r.root, "clash.txt", "from main\n");
    assert!(!sync::rebase_onto(&core, &wt, "feat/b", "main").unwrap().ok);
    let e = branch::switch_in(&core, &wt, "feat/c")
        .unwrap_err()
        .to_string();
    assert_eq!(
        e,
        "work-feat-a has a rebase or merge in progress. Continue or abort it first."
    );
}

/// How far the base has moved on without a worktree's branch. The base is
/// origin/main as of the last fetch, not the local main; with no remote it's
/// the local main.
#[test]
fn behind_base_counts_against_origin_main_then_local_main() {
    let r = repo();
    let wt = add_worktree(&r, "feat/a", "work-feat-a");
    commit(&wt, "a.txt", "a\n");
    git(&r.root, &["branch", "loose"]);
    let row = |o: &overview::Overview, n: &str| {
        o.branches
            .iter()
            .find(|b| b.branch.name == n)
            .unwrap()
            .clone()
    };
    let o = overview::load(&r.core()).unwrap();
    assert_eq!(o.compare_base.as_deref(), Some("origin/main"));
    assert_eq!(row(&o, "feat/a").behind_base, Some(0));

    // Two commits on local main, not pushed: origin/main hasn't moved.
    commit(&r.root, "m1.txt", "1\n");
    commit(&r.root, "m2.txt", "2\n");
    let o = overview::load(&r.core()).unwrap();
    assert_eq!(row(&o, "feat/a").behind_base, Some(0));
    assert_eq!(row(&o, "main").behind_base, Some(0));

    git(&r.root, &["push", "-q", "origin", "main"]);
    let o = overview::load(&r.core()).unwrap();
    assert_eq!(row(&o, "feat/a").behind_base, Some(2));
    assert_eq!(row(&o, "feat/a").ahead_of_base, Some(1));
    // No worktree: not counted. And never on the quick load.
    assert_eq!(row(&o, "loose").behind_base, None);
    let q = overview::load_quick(&r.core()).unwrap();
    assert_eq!(row(&q, "feat/a").behind_base, None);

    // No remote: the local main is the base.
    commit(&r.root, "m3.txt", "3\n");
    git(&r.root, &["remote", "remove", "origin"]);
    let o = overview::load(&r.core()).unwrap();
    assert_eq!(o.compare_base.as_deref(), Some("main"));
    assert_eq!(row(&o, "feat/a").behind_base, Some(3));
}

/// The user can pick what branches are compared to: any local or remote
/// branch. One that's gone, or isn't a branch, falls back to the usual base.
#[test]
fn a_chosen_base_changes_what_ahead_behind_and_merged_are_measured_against() {
    let r = repo();
    // develop: one commit past main.
    git(&r.root, &["switch", "-q", "-c", "develop"]);
    commit(&r.root, "d.txt", "d\n");
    // feat/in-dev: one commit, merged into develop. Already in develop, not in main.
    let done = r.sibling("work-in-dev");
    git(
        &r.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/in-dev",
            done.to_str().unwrap(),
            "develop",
        ],
    );
    commit(&done, "i.txt", "i\n");
    git(
        &r.root,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Merge feat/in-dev",
            "feat/in-dev",
        ],
    );
    git(&r.root, &["push", "-q", "-u", "origin", "develop"]);
    git(&r.root, &["switch", "-q", "main"]);
    // feat/a: branched from develop, one commit of its own.
    let wt = r.sibling("work-feat-a");
    git(
        &r.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/a",
            wt.to_str().unwrap(),
            "develop",
        ],
    );
    commit(&wt, "a.txt", "a\n");
    let row = |o: &overview::Overview, n: &str| {
        o.branches
            .iter()
            .find(|b| b.branch.name == n)
            .unwrap()
            .clone()
    };
    let core = r.core();

    let usual = overview::load_against(&core, false, None).unwrap();
    assert_eq!(usual.compare_base.as_deref(), Some("origin/main"));
    assert_eq!(row(&usual, "feat/a").ahead_of_base, Some(4));
    assert!(!row(&usual, "feat/in-dev").merged);

    for base in ["origin/develop", "develop"] {
        let o = overview::load_against(&core, false, Some(base)).unwrap();
        assert_eq!(o.compare_base.as_deref(), Some(base));
        // The default branch is still what it was.
        assert_eq!(o.base.as_deref(), Some("main"));
        assert_eq!(row(&o, "feat/a").ahead_of_base, Some(1), "{base}");
        assert_eq!(row(&o, "feat/a").behind_base, Some(0), "{base}");
        assert!(row(&o, "feat/in-dev").merged, "{base}");
        assert_eq!(row(&o, "feat/in-dev").merged_in.as_deref(), Some(base));
    }
    // Develop moves on: feat/a is now behind it.
    git(&r.root, &["switch", "-q", "develop"]);
    commit(&r.root, "d2.txt", "d2\n");
    git(&r.root, &["switch", "-q", "main"]);
    let o = overview::load_against(&core, false, Some("develop")).unwrap();
    assert_eq!(row(&o, "feat/a").behind_base, Some(1));
    // The remote copy hasn't moved, so against it nothing is behind.
    let o = overview::load_against(&core, false, Some("origin/develop")).unwrap();
    assert_eq!(row(&o, "feat/a").behind_base, Some(0));

    // Gone, nonsense, or an option in disguise: the usual base, never an error.
    for bad in [
        "origin/gone",
        "nope",
        "",
        "--all",
        "main..develop",
        "refs/heads/main",
        "HEAD",
    ] {
        let o = overview::load_against(&core, false, Some(bad)).unwrap();
        assert_eq!(o.compare_base.as_deref(), Some("origin/main"), "{bad:?}");
    }
    // Quick load honours it too.
    let q = overview::load_against(&core, true, Some("develop")).unwrap();
    assert!(!q.status_loaded);
    assert_eq!(q.compare_base.as_deref(), Some("develop"));
    assert_eq!(row(&q, "feat/a").ahead_of_base, Some(1));
}
