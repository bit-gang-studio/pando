//! What a branch is built on, what's built on it, and where it left the base.
mod common;
use common::*;
use pando_core::relate::{self, Link};

fn link(name: &str, remote: bool, commits: u32) -> Link {
    Link {
        name: name.to_string(),
        remote,
        commits,
    }
}

/// main ── step-1 (2 commits) ── step-2 (1) ── step-3 (3), and side (1) off step-1.
/// Then main moves on by 2. Everything pushed except step-3.
fn stack() -> Repo {
    let r = repo();
    git(&r.root, &["switch", "-q", "-c", "step-1"]);
    commit(&r.root, "1a.txt", "1a\n");
    commit(&r.root, "1b.txt", "1b\n");
    git(&r.root, &["switch", "-q", "-c", "side"]);
    commit(&r.root, "side.txt", "s\n");
    git(&r.root, &["switch", "-q", "-c", "step-2", "step-1"]);
    commit(&r.root, "2.txt", "2\n");
    git(&r.root, &["switch", "-q", "-c", "step-3"]);
    for n in ["3a", "3b", "3c"] {
        commit(&r.root, &format!("{n}.txt"), "3\n");
    }
    git(
        &r.root,
        &["push", "-q", "origin", "step-1", "step-2", "side"],
    );
    git(&r.root, &["switch", "-q", "main"]);
    commit(&r.root, "m1.txt", "m\n");
    commit(&r.root, "m2.txt", "m\n");
    git(&r.root, &["push", "-q", "origin", "main"]);
    r
}

#[test]
fn a_stacked_branch_names_what_it_is_built_on_in_order() {
    let r = stack();
    let got = relate::load(&r.core(), "step-3", "origin/main").unwrap();
    assert_eq!(
        got.below,
        [link("step-1", false, 2), link("step-2", false, 1)]
    );
    assert_eq!(got.own, 3);
    assert_eq!(got.ahead, 6);
    assert_eq!(got.behind, 2);
    assert!(got.above.is_empty());
    // It forked where main was before main moved on.
    assert_eq!(got.fork.unwrap().id, r.tip("main~2"));
}

#[test]
fn the_middle_of_a_stack_sees_both_ways_and_ignores_side_branches_below() {
    let r = stack();
    let mid = relate::load(&r.core(), "step-2", "origin/main").unwrap();
    assert_eq!(mid.below, [link("step-1", false, 2)]);
    assert_eq!(mid.own, 1);
    assert_eq!(mid.above, [link("step-3", false, 3)]);
    // step-1 has two branches on top: the nearer first, by commits.
    let bottom = relate::load(&r.core(), "step-1", "origin/main").unwrap();
    assert!(bottom.below.is_empty());
    assert_eq!(bottom.own, 2);
    assert_eq!(
        bottom.above,
        [
            link("side", false, 1),
            link("step-2", false, 1),
            link("step-3", false, 4)
        ]
    );
    // side isn't in step-3's history, so it isn't under it.
    let top = relate::load(&r.core(), "step-3", "origin/main").unwrap();
    assert!(!top.below.iter().any(|l| l.name == "side"));
}

#[test]
fn a_remote_branch_shows_only_when_no_local_branch_stands_for_it() {
    let r = stack();
    // A teammate's branch on top of step-2, fetched but never checked out.
    let mate = r.sibling("mate");
    git(
        &r.base,
        &["clone", "-q", r.origin.to_str().unwrap(), "mate"],
    );
    for (k, v) in [
        ("user.name", "Mate"),
        ("user.email", "m@e"),
        ("commit.gpgsign", "false"),
    ] {
        git(&mate, &["config", k, v]);
    }
    git(&mate, &["switch", "-q", "-c", "theirs", "origin/step-2"]);
    commit(&mate, "t.txt", "t\n");
    git(&mate, &["push", "-q", "origin", "theirs"]);
    git(&r.root, &["fetch", "-q", "origin"]);
    let mid = relate::load(&r.core(), "step-2", "origin/main").unwrap();
    assert_eq!(
        mid.above,
        [link("origin/theirs", true, 1), link("step-3", false, 3)]
    );
    // origin/step-1 and origin/step-2 exist too, but the local ones stand for them.
    assert_eq!(mid.below, [link("step-1", false, 2)]);
    // Delete local step-1: now the remote copy is what it's built on.
    git(&r.root, &["branch", "-q", "-D", "step-1"]);
    let mid = relate::load(&r.core(), "step-2", "origin/main").unwrap();
    assert_eq!(mid.below, [link("origin/step-1", true, 2)]);
}

#[test]
fn a_plain_branch_a_fresh_branch_and_a_commit_id() {
    let r = repo();
    let wt = add_worktree(&r, "feat/a", "work-feat-a");
    let core = r.core();
    // Brand new: nothing of its own, nothing behind.
    let fresh = relate::load(&core, "feat/a", "origin/main").unwrap();
    assert_eq!((fresh.ahead, fresh.behind, fresh.own), (0, 0, 0));
    assert!(fresh.below.is_empty() && fresh.above.is_empty());
    commit(&wt, "a.txt", "a\n");
    let plain = relate::load(&core, "feat/a", "origin/main").unwrap();
    assert_eq!((plain.ahead, plain.own), (1, 1));
    // By commit id, as for a worktree with no branch: the branch on that commit isn't "on top".
    let id = git(&wt, &["rev-parse", "HEAD"]);
    let by_id = relate::load(&core, &id, "main").unwrap();
    assert_eq!(by_id.own, 1);
    assert!(by_id.above.is_empty());
    // A branch with a slash and odd letters in its name.
    git(&r.root, &["branch", "fix/ünï-code", "feat/a"]);
    git(&wt, &["switch", "-q", "fix/ünï-code"]);
    commit(&wt, "u.txt", "u\n");
    let odd = relate::load(&core, "fix/ünï-code", "main").unwrap();
    assert_eq!(odd.below, [link("feat/a", false, 1)]);
}

#[test]
fn refuses_nonsense_and_handles_branches_with_no_shared_history() {
    let r = repo();
    let core = r.core();
    for bad in ["", "--all", "a..b", "nope", "refs/heads/nope"] {
        assert!(relate::load(&core, bad, "main").is_err(), "{bad:?}");
        assert!(relate::load(&core, "main", bad).is_err(), "{bad:?}");
    }
    // An orphan branch: no fork point, and it says so by having none.
    git(&r.root, &["switch", "-q", "--orphan", "island"]);
    commit(&r.root, "i.txt", "i\n");
    git(&r.root, &["switch", "-q", "main"]);
    let got = relate::load(&core, "island", "main").unwrap();
    assert!(got.fork.is_none());
    assert_eq!(got.own, 1);
    // A remote branch whose name only ends like the base's isn't mistaken for the base.
    git(&r.root, &["switch", "-q", "-c", "domain"]);
    commit(&r.root, "d.txt", "d\n");
    git(&r.root, &["push", "-q", "origin", "domain"]);
    git(&r.root, &["switch", "-q", "-c", "on-domain"]);
    commit(&r.root, "o.txt", "o\n");
    git(&r.root, &["switch", "-q", "main"]);
    git(&r.root, &["branch", "-q", "-D", "domain"]);
    let got = relate::load(&core, "on-domain", "main").unwrap();
    assert_eq!(got.below, [link("origin/domain", true, 1)]);
    // The base against itself.
    let same = relate::load(&core, "main", "origin/main").unwrap();
    assert_eq!((same.ahead, same.behind), (0, 0));
    assert!(same.below.is_empty());
}
