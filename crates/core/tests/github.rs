//! Checking out pull requests into worktrees, against a local "GitHub".
mod common;
use common::*;
use pando_core::github::{self, Checks, PullRequest};

fn pr(number: u64, head: &str, from_fork: bool) -> PullRequest {
    PullRequest {
        number,
        title: "t".into(),
        author: "a".into(),
        draft: false,
        head: head.into(),
        base: "main".into(),
        from_fork,
        url: String::new(),
        checks: Checks::None,
        review: String::new(),
        updated_at: String::new(),
    }
}

#[test]
fn a_pr_from_this_repo_gets_its_branch_and_tracks_it() {
    let r = repo();
    // Someone else pushes feat/login and opens a PR.
    let other = r.sibling("someone");
    git(
        &r.base,
        &["clone", "-q", r.origin.to_str().unwrap(), "someone"],
    );
    git(&other, &["switch", "-q", "-c", "feat/login"]);
    commit(&other, "login.txt", "login\n");
    git(&other, &["push", "-q", "origin", "feat/login"]);

    let made = github::add_worktree(&r.core(), &pr(12, "feat/login", false)).unwrap();
    let p = made.worktree.path;
    assert_eq!(read(&p, "login.txt"), "login\n");
    assert_eq!(
        git(&p, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/feat/login"
    );

    // Asking again returns the same worktree instead of failing.
    let again = github::add_worktree(&r.core(), &pr(12, "feat/login", false)).unwrap();
    assert_eq!(again.worktree.path, p);
}

#[test]
fn a_pr_from_a_fork_becomes_pr_number() {
    let r = repo();
    // GitHub keeps fork PRs at refs/pull/<n>/head on the base repo.
    let fork = r.sibling("fork");
    git(
        &r.base,
        &["clone", "-q", r.origin.to_str().unwrap(), "fork"],
    );
    commit(&fork, "fork.txt", "from a fork\n");
    let tip = git(&fork, &["rev-parse", "HEAD"]);
    git(&fork, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);

    let made = github::add_worktree(&r.core(), &pr(7, "main", true)).unwrap();
    assert_eq!(made.worktree.branch.as_deref(), Some("pr/7"));
    assert_eq!(git(&made.worktree.path, &["rev-parse", "HEAD"]), tip);
    assert_eq!(
        r.tip("main"),
        git(&r.root, &["rev-parse", "origin/main"]),
        "our main untouched"
    );
}

#[test]
fn a_missing_pr_fails_cleanly() {
    let r = repo();
    assert!(github::add_worktree(&r.core(), &pr(99, "nope", false)).is_err());
    assert!(github::add_worktree(&r.core(), &pr(98, "x", true)).is_err());
    assert_eq!(pando_core::worktree::list(&r.core()).unwrap().len(), 1);
    assert!(!git_ok(&r.root, &["rev-parse", "--verify", "pr/98"]));
}
