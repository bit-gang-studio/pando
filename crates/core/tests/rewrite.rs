//! Reword, squash and drop a branch's own commits.
mod common;
use common::*;
use pando_core::{branch, operation, rewrite, worktree, Repo as CoreRepo};
use std::path::{Path, PathBuf};

/// feat/x in its own worktree with commits a, b, c, d (oldest first), none pushed.
fn four() -> (Repo, PathBuf, Vec<String>) {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    let mut ids = vec![];
    for (name, body) in [
        ("a.txt", "a\n"),
        ("b.txt", "b\n"),
        ("c.txt", "c\n"),
        ("d.txt", "d\n"),
    ] {
        commit(&wt, name, body);
        ids.push(git(&wt, &["rev-parse", "HEAD"]));
    }
    (r, wt, ids)
}
fn subjects(cwd: &Path, range: &str) -> Vec<String> {
    git(cwd, &["log", "--format=%s", range])
        .lines()
        .map(str::to_string)
        .collect()
}
fn tree(cwd: &Path, rev: &str) -> String {
    git(cwd, &["rev-parse", &format!("{rev}^{{tree}}")])
}
fn err(r: pando_core::Result<rewrite::Rewritten>) -> String {
    r.unwrap_err().to_string()
}

#[test]
fn reword_changes_one_message_and_nothing_else() {
    let (r, wt, ids) = four();
    let core = r.core();
    // Uncommitted work, staged and not: reword must not care or touch it.
    write(&wt, "d.txt", "d\nunsaved\n");
    write(&wt, "new.txt", "staged\n");
    git(&wt, &["add", "new.txt"]);
    let status = git(&wt, &["status", "--porcelain"]);
    let trees: Vec<String> = (0..4).map(|i| tree(&wt, &format!("HEAD~{i}"))).collect();
    let dates = git(&wt, &["log", "--format=%an|%ae|%ad", "-4"]);

    let out = rewrite::reword(
        &core,
        "feat/x",
        &ids[1],
        "  Better message\n\nWith a body.\n\n",
    )
    .unwrap();
    assert_eq!(out.old_tip, ids[3]);
    assert_eq!(out.new_tip, git(&wt, &["rev-parse", "HEAD"]));
    assert!(!out.paused);
    assert_eq!(
        subjects(&wt, "origin/main..HEAD"),
        ["edit d.txt", "edit c.txt", "Better message", "edit a.txt"]
    );
    assert_eq!(
        git(&wt, &["log", "-1", "--format=%B", "HEAD~2"]),
        "Better message\n\nWith a body."
    );
    assert_eq!(
        (0..4)
            .map(|i| tree(&wt, &format!("HEAD~{i}")))
            .collect::<Vec<_>>(),
        trees
    );
    assert_eq!(
        git(&wt, &["log", "--format=%an|%ae|%ad", "-4"]),
        dates,
        "authors and dates kept"
    );
    assert_eq!(
        git(&wt, &["rev-parse", "HEAD~3"]),
        ids[0],
        "commits before it are untouched"
    );
    assert_eq!(git(&wt, &["status", "--porcelain"]), status);
    assert_eq!(read(&wt, "d.txt"), "d\nunsaved\n");
    // A backup of the old tip, and Undo puts the branch back.
    assert_eq!(r.tip("refs/pando/backup/feat/x"), ids[3]);
    rewrite::undo(&core, "feat/x", &out.new_tip, &out.old_tip).unwrap();
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
    assert_eq!(git(&wt, &["status", "--porcelain"]), status);
}

#[test]
fn reword_the_tip_and_odd_messages() {
    let (r, wt, ids) = four();
    let core = r.core();
    rewrite::reword(
        &core,
        "feat/x",
        &ids[3],
        "-m looks like a flag\n\n# not a comment\nünï \"quotes\" 'single' $HOME `x`",
    )
    .unwrap();
    assert_eq!(
        git(&wt, &["log", "-1", "--format=%B"]),
        "-m looks like a flag\n\n# not a comment\nünï \"quotes\" 'single' $HOME `x`"
    );
    for empty in ["", "   ", "\n\n"] {
        assert!(err(rewrite::reword(&core, "feat/x", &ids[2], empty)).contains("needs a message"));
    }
}

#[test]
fn reword_works_on_a_branch_with_no_worktree_and_on_a_first_commit() {
    let (r, wt, ids) = four();
    let core = r.core();
    worktree::remove(&core, &wt, false).unwrap();
    rewrite::reword(&core, "feat/x", &ids[0], "First, reworded").unwrap();
    assert_eq!(
        subjects(&r.root, "origin/main..feat/x"),
        ["edit d.txt", "edit c.txt", "edit b.txt", "First, reworded"]
    );

    // A repo with no remote: even the very first commit can be reworded.
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("solo");
    git(tmp.path(), &["init", "-q", "-b", "main", "solo"]);
    for (k, v) in [
        ("user.name", "T"),
        ("user.email", "t@e"),
        ("commit.gpgsign", "false"),
    ] {
        git(&root, &["config", k, v]);
    }
    commit(&root, "one.txt", "1\n");
    commit(&root, "two.txt", "2\n");
    let solo = CoreRepo::discover(&root).unwrap();
    let first = git(&root, &["rev-list", "--max-parents=0", "HEAD"]);
    rewrite::reword(&solo, "main", &first, "The beginning").unwrap();
    assert_eq!(subjects(&root, "HEAD"), ["edit two.txt", "The beginning"]);
    assert_eq!(git(&root, &["status", "--porcelain"]), "");
}

#[test]
fn a_merge_after_the_reworded_commit_keeps_both_parents() {
    let (r, wt, ids) = four();
    git(&wt, &["switch", "-q", "-c", "side", &ids[1]]);
    commit(&wt, "side.txt", "s\n");
    git(&wt, &["switch", "-q", "feat/x"]);
    git(&wt, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let before = tree(&wt, "HEAD");
    rewrite::reword(&r.core(), "feat/x", &ids[2], "c, reworded").unwrap();
    assert_eq!(
        git(&wt, &["log", "-1", "--format=%s %P"])
            .split(' ')
            .count(),
        4,
        "merge side + 2 parents"
    );
    assert_eq!(tree(&wt, "HEAD"), before);
    assert_eq!(
        git(&wt, &["rev-parse", "HEAD^2"]),
        git(&wt, &["rev-parse", "side"]),
        "the side branch is untouched"
    );
    assert!(subjects(&wt, "origin/main..HEAD").contains(&"c, reworded".to_string()));
}

#[test]
fn with_no_remote_the_local_base_is_still_off_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("solo");
    git(tmp.path(), &["init", "-q", "-b", "main", "solo"]);
    for (k, v) in [
        ("user.name", "T"),
        ("user.email", "t@e"),
        ("commit.gpgsign", "false"),
    ] {
        git(&root, &["config", k, v]);
    }
    commit(&root, "one.txt", "1\n");
    let on_main = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["switch", "-q", "-c", "feat"]);
    commit(&root, "two.txt", "2\n");
    let core = CoreRepo::discover(&root).unwrap();
    assert_eq!(
        rewrite::editable(&core, "feat").unwrap(),
        vec![git(&root, &["rev-parse", "HEAD"])]
    );
    let e = err(rewrite::reword(&core, "feat", &on_main, "x"));
    assert!(e.contains("is on main"), "{e}");
}

#[test]
fn squash_makes_one_commit_with_the_same_files() {
    let (r, wt, ids) = four();
    let core = r.core();
    write(&wt, "a.txt", "a\nunsaved\n");
    let before = tree(&wt, "HEAD");
    let first_date = git(&wt, &["log", "-1", "--format=%an|%ad", &ids[0]]);
    let out = rewrite::squash(&core, "feat/x", &ids[0], &ids[2], "a, b and c together").unwrap();
    assert_eq!(
        subjects(&wt, "origin/main..HEAD"),
        ["edit d.txt", "a, b and c together"]
    );
    assert_eq!(tree(&wt, "HEAD"), before);
    assert_eq!(tree(&wt, "HEAD~1"), tree(&wt, &ids[2]));
    assert_eq!(
        git(&wt, &["log", "-1", "--format=%an|%ad", "HEAD~1"]),
        first_date
    );
    assert_eq!(read(&wt, "a.txt"), "a\nunsaved\n");
    assert_eq!(git(&wt, &["status", "--porcelain"]), "M a.txt");
    rewrite::undo(&core, "feat/x", &out.new_tip, &out.old_tip).unwrap();
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
    // Everything, tip included, given newest-first by mistake: refused, not guessed.
    assert!(
        err(rewrite::squash(&core, "feat/x", &ids[3], &ids[0], "x")).contains("doesn't lead to")
    );
    assert!(err(rewrite::squash(&core, "feat/x", &ids[2], &ids[2], "x")).contains("at least two"));
    assert!(
        err(rewrite::squash(&core, "feat/x", &ids[0], &ids[3], " ")).contains("needs a message")
    );
    rewrite::squash(&core, "feat/x", &ids[0], &ids[3], "all four").unwrap();
    assert_eq!(subjects(&wt, "origin/main..HEAD"), ["all four"]);
    assert_eq!(tree(&wt, "HEAD"), before);
}

#[test]
fn squash_refuses_a_run_with_a_merge_in_it() {
    let (r, wt, ids) = four();
    git(&wt, &["switch", "-q", "-c", "side", &ids[1]]);
    commit(&wt, "side.txt", "s\n");
    git(&wt, &["switch", "-q", "feat/x"]);
    git(&wt, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let merge = git(&wt, &["rev-parse", "HEAD"]);
    commit(&wt, "e.txt", "e\n");
    let tip = git(&wt, &["rev-parse", "HEAD"]);
    assert!(err(rewrite::squash(&r.core(), "feat/x", &ids[2], &tip, "x")).contains("is a merge"));
    assert!(err(rewrite::squash(&r.core(), "feat/x", &merge, &tip, "x")).contains("is a merge"));
    assert!(err(rewrite::drop(&r.core(), "feat/x", &merge)).contains("is a merge"));
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), tip);
}

#[test]
fn drop_removes_a_commit_and_its_files() {
    let (r, wt, ids) = four();
    let core = r.core();
    write(&wt, "untracked.txt", "keep\n");
    let out = rewrite::drop(&core, "feat/x", &ids[1]).unwrap();
    assert!(!out.paused);
    assert_eq!(
        subjects(&wt, "origin/main..HEAD"),
        ["edit d.txt", "edit c.txt", "edit a.txt"]
    );
    assert!(!wt.join("b.txt").exists());
    assert_eq!(read(&wt, "untracked.txt"), "keep\n");
    assert_eq!(out.new_tip, git(&wt, &["rev-parse", "HEAD"]));
    // Undo brings the commit and its file back.
    rewrite::undo(&core, "feat/x", &out.new_tip, &out.old_tip).unwrap();
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
    assert_eq!(read(&wt, "b.txt"), "b\n");
    // The tip can be dropped too.
    rewrite::drop(&core, "feat/x", &ids[3]).unwrap();
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[2]);
    assert!(!wt.join("d.txt").exists());
}

#[test]
fn drop_refuses_uncommitted_changes_and_a_branch_with_no_worktree() {
    let (r, wt, ids) = four();
    let core = r.core();
    write(&wt, "a.txt", "a\nunsaved\n");
    assert!(err(rewrite::drop(&core, "feat/x", &ids[1])).contains("Commit or stash"));
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
    assert_eq!(read(&wt, "a.txt"), "a\nunsaved\n");
    git(&wt, &["checkout", "-q", "--", "a.txt"]);
    worktree::remove(&core, &wt, false).unwrap();
    assert!(err(rewrite::drop(&core, "feat/x", &ids[1])).contains("Add a worktree"));
    assert_eq!(r.tip("feat/x"), ids[3]);
}

#[test]
fn a_drop_that_conflicts_pauses_and_abort_puts_everything_back() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    commit(&wt, "f.txt", "one\n");
    let first = git(&wt, &["rev-parse", "HEAD"]);
    commit(&wt, "f.txt", "one\ntwo\n");
    let tip = git(&wt, &["rev-parse", "HEAD"]);
    let core = r.core();
    let out = rewrite::drop(&core, "feat/x", &first).unwrap();
    assert!(out.paused);
    let op = operation::detect(&wt).unwrap().unwrap();
    assert_eq!(op.conflicted, vec!["f.txt"]);
    // While it's paused, nothing else may rewrite the branch.
    assert!(err(rewrite::reword(&core, "feat/x", &tip, "x")).contains("in progress"));
    assert!(rewrite::undo(&core, "feat/x", &tip, &first).is_err());
    operation::abort(&wt).unwrap();
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), tip);
    assert_eq!(git(&wt, &["status", "--porcelain"]), "");
    assert_eq!(read(&wt, "f.txt"), "one\ntwo\n");
}

#[test]
fn undo_refuses_when_the_branch_has_moved_on() {
    let (r, wt, ids) = four();
    let core = r.core();
    let out = rewrite::reword(&core, "feat/x", &ids[3], "reworded").unwrap();
    commit(&wt, "later.txt", "x\n");
    let now = git(&wt, &["rev-parse", "HEAD"]);
    let e = rewrite::undo(&core, "feat/x", &out.new_tip, &out.old_tip)
        .unwrap_err()
        .to_string();
    assert!(e.contains("has changed since"), "{e}");
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), now);
}

/// Push feat/x's first `n` commits to origin/<to>.
fn push_first(wt: &Path, ids: &[String], n: usize, to: &str) {
    git(
        wt,
        &[
            "push",
            "-q",
            "origin",
            &format!("{}:refs/heads/{to}", ids[n - 1]),
        ],
    );
}
/// Push a and b to origin/feat/x and track it; c and d stay local.
fn track_first_two(wt: &Path, ids: &[String]) {
    push_first(wt, ids, 2, "feat/x");
    git(
        wt,
        &["branch", "-q", "--set-upstream-to=origin/feat/x", "feat/x"],
    );
}
/// feat/x pushed in full, tracking origin/feat/x.
fn four_pushed() -> (Repo, PathBuf, Vec<String>) {
    let (r, wt, ids) = four();
    git(&wt, &["push", "-q", "-u", "origin", "feat/x"]);
    (r, wt, ids)
}
fn row(r: &Repo, name: &str) -> branch::Branch {
    branch::list(&r.core())
        .unwrap()
        .into_iter()
        .find(|b| b.name == name)
        .unwrap()
}
/// A second clone commits on top of origin/feat/x and pushes.
fn teammate_pushes(r: &Repo) -> String {
    let dir = r.base.join("teammate");
    if !dir.exists() {
        git(
            &r.base,
            &["clone", "-q", r.origin.to_str().unwrap(), "teammate"],
        );
        for (k, v) in [
            ("user.name", "Ana"),
            ("user.email", "ana@e"),
            ("commit.gpgsign", "false"),
        ] {
            git(&dir, &["config", k, v]);
        }
        git(&dir, &["switch", "-q", "feat/x"]);
    }
    let n = git(&dir, &["rev-list", "--count", "HEAD"]);
    commit(&dir, "ana.txt", &format!("from ana {n}\n"));
    git(&dir, &["push", "-q", "origin", "feat/x"]);
    git(&dir, &["rev-parse", "HEAD"])
}

#[test]
fn a_branchs_own_commits_are_editable_pushed_or_not_but_shared_ones_never() {
    let (r, wt, ids) = four();
    let core = r.core();
    let mut all = ids.clone();
    all.reverse();
    assert_eq!(rewrite::editable(&core, "feat/x").unwrap(), all);
    assert!(rewrite::pushed(&core, "feat/x").unwrap().is_empty());
    // Pushed to its own upstream: still editable, and listed as pushed.
    track_first_two(&wt, &ids);
    assert_eq!(rewrite::editable(&core, "feat/x").unwrap(), all);
    assert_eq!(
        rewrite::pushed(&core, "feat/x").unwrap(),
        vec![ids[1].clone(), ids[0].clone()]
    );
    // The first commit is also on another remote branch: someone builds on it.
    push_first(&wt, &ids, 1, "shared");
    git(&wt, &["fetch", "-q", "origin"]);
    assert_eq!(rewrite::editable(&core, "feat/x").unwrap(), all[..3]);
    assert_eq!(
        rewrite::pushed(&core, "feat/x").unwrap(),
        vec![ids[1].clone()]
    );
    let e = err(rewrite::reword(&core, "feat/x", &ids[0], "x"));
    assert!(
        e.contains("is on origin/shared") && e.contains("yours alone"),
        "{e}"
    );
    assert!(err(rewrite::squash(&core, "feat/x", &ids[0], &ids[1], "x")).contains("origin/shared"));
    assert!(err(rewrite::drop(&core, "feat/x", &ids[0])).contains("origin/shared"));
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
}

#[test]
fn the_default_branch_and_strangers_are_never_editable() {
    let (r, wt, ids) = four();
    let core = r.core();
    // main tracks origin/main, the default branch: pushed commits there stay put.
    assert!(rewrite::editable(&core, "main").unwrap().is_empty());
    assert!(err(rewrite::reword(&core, "main", &r.tip("main"), "x")).contains("on origin/main"));
    assert!(err(rewrite::reword(&core, "feat/x", &r.tip("main"), "x")).contains("on origin/main"));
    commit(&r.root, "local.txt", "x\n");
    assert_eq!(
        rewrite::editable(&core, "main").unwrap(),
        vec![r.tip("main")]
    );
    assert!(rewrite::pushed(&core, "main").unwrap().is_empty());
    assert!(err(rewrite::reword(&core, "feat/x", &r.tip("main"), "x")).contains("isn't on feat/x"));
    for bad in ["HEAD", "--all", "", "zzzz", "feat/x", "deadbeefdeadbeef"] {
        assert!(rewrite::reword(&core, "feat/x", bad, "x").is_err(), "{bad}");
        assert!(rewrite::drop(&core, "feat/x", bad).is_err(), "{bad}");
    }
    assert!(rewrite::editable(&core, "nope").is_err());
    assert!(rewrite::reword(&core, "no-such-branch", &ids[3], "x").is_err());
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
}

#[test]
fn reword_a_pushed_commit_then_force_push_updates_the_remote() {
    let (r, wt, ids) = four_pushed();
    let core = r.core();
    assert!(!row(&r, "feat/x").upstream_rewritten);
    rewrite::reword(&core, "feat/x", &ids[1], "b, reworded").unwrap();
    let b = row(&r, "feat/x");
    assert_eq!((b.ahead, b.behind), (Some(3), Some(3)));
    assert!(
        b.upstream_rewritten,
        "the remote only has commits we replaced"
    );
    assert_eq!(
        git(&r.origin, &["rev-parse", "feat/x"]),
        ids[3],
        "nothing pushed yet"
    );

    branch::force_push(&core, "feat/x").unwrap();
    assert_eq!(
        git(&r.origin, &["rev-parse", "feat/x"]),
        git(&wt, &["rev-parse", "HEAD"])
    );
    let b = row(&r, "feat/x");
    assert_eq!(
        (b.ahead, b.behind, b.upstream_rewritten),
        (Some(0), Some(0), false)
    );
    // The remote's old tip is still reachable here.
    let kept = git(
        &r.root,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/pando/snapshots/force-push",
        ],
    );
    assert_eq!(kept, ids[3]);
    // Doing it again with nothing to push is harmless.
    branch::force_push(&core, "feat/x").unwrap();
}

#[test]
fn drop_a_pushed_commit_then_force_push() {
    let (r, wt, ids) = four_pushed();
    let core = r.core();
    rewrite::drop(&core, "feat/x", &ids[2]).unwrap();
    assert!(row(&r, "feat/x").upstream_rewritten);
    branch::force_push(&core, "feat/x").unwrap();
    assert_eq!(
        subjects(&r.origin, "main..feat/x"),
        ["edit d.txt", "edit b.txt", "edit a.txt"]
    );
    assert_eq!(
        git(&r.origin, &["rev-parse", "feat/x"]),
        git(&wt, &["rev-parse", "HEAD"])
    );
}

#[test]
fn a_teammates_unpulled_commits_block_changing_pushed_commits() {
    let (r, wt, ids) = four_pushed();
    let core = r.core();
    let ana = teammate_pushes(&r);
    git(&wt, &["fetch", "-q", "origin"]);
    let e = err(rewrite::reword(&core, "feat/x", &ids[1], "x"));
    assert!(
        e.contains("origin/feat/x has commits you haven't pulled"),
        "{e}"
    );
    assert!(err(rewrite::drop(&core, "feat/x", &ids[3])).contains("haven't pulled"));
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), ids[3]);
    // A new local commit isn't pushed: that one can still change.
    commit(&wt, "e.txt", "e\n");
    let mine = git(&wt, &["rev-parse", "HEAD"]);
    rewrite::reword(&core, "feat/x", &mine, "e, reworded").unwrap();
    // Ahead and behind, but not from a rewrite: force push is refused.
    let b = row(&r, "feat/x");
    assert_eq!(
        (b.ahead, b.behind, b.upstream_rewritten),
        (Some(1), Some(1), false)
    );
    let e = branch::force_push(&core, "feat/x").unwrap_err().to_string();
    assert!(e.contains("never had") && e.contains("Pull first"), "{e}");
    assert_eq!(git(&r.origin, &["rev-parse", "feat/x"]), ana);
}

#[test]
fn a_teammate_pushing_after_our_rewrite_is_never_overwritten() {
    let (r, wt, ids) = four_pushed();
    let core = r.core();
    rewrite::reword(&core, "feat/x", &ids[3], "d, reworded").unwrap();
    let ana = teammate_pushes(&r);
    // Not fetched: our view of the remote is stale. Git's lease catches it.
    assert!(row(&r, "feat/x").upstream_rewritten);
    assert!(branch::force_push(&core, "feat/x").is_err());
    assert_eq!(git(&r.origin, &["rev-parse", "feat/x"]), ana);
    // Fetched: now we can see her commit, and refuse before pushing.
    git(&wt, &["fetch", "-q", "origin"]);
    assert!(!row(&r, "feat/x").upstream_rewritten);
    let e = branch::force_push(&core, "feat/x").unwrap_err().to_string();
    assert!(e.contains("never had"), "{e}");
    assert_eq!(git(&r.origin, &["rev-parse", "feat/x"]), ana);
    // A second teammate push, fetched again: still refused.
    let ana2 = teammate_pushes(&r);
    git(&wt, &["fetch", "-q", "origin"]);
    assert!(branch::force_push(&core, "feat/x").is_err());
    assert_eq!(git(&r.origin, &["rev-parse", "feat/x"]), ana2);
}

#[test]
fn force_push_refuses_the_default_branch_and_a_branch_with_no_upstream() {
    let (r, wt, ids) = four();
    let core = r.core();
    let e = branch::force_push(&core, "feat/x").unwrap_err().to_string();
    assert!(e.contains("no upstream yet"), "{e}");
    commit(&r.root, "local.txt", "x\n");
    git(&r.root, &["commit", "-q", "--amend", "-m", "amended"]);
    let before = git(&r.origin, &["rev-parse", "main"]);
    let e = branch::force_push(&core, "main").unwrap_err().to_string();
    assert!(e.contains("doesn't force push main"), "{e}");
    assert_eq!(git(&r.origin, &["rev-parse", "main"]), before);
    assert!(branch::force_push(&core, "nope").is_err());
    // Only ahead: it's a plain push.
    track_first_two(&wt, &ids);
    branch::force_push(&core, "feat/x").unwrap();
    assert_eq!(git(&r.origin, &["rev-parse", "feat/x"]), ids[3]);
    assert!(git(
        &r.root,
        &["for-each-ref", "refs/pando/snapshots/force-push"]
    )
    .is_empty());
}

#[test]
fn an_amend_in_a_terminal_counts_as_a_rewrite_too() {
    let (r, wt, _ids) = four_pushed();
    git(
        &wt,
        &["commit", "-q", "--amend", "-m", "amended in a terminal"],
    );
    assert!(row(&r, "feat/x").upstream_rewritten);
    branch::force_push(&r.core(), "feat/x").unwrap();
    assert_eq!(
        git(&r.origin, &["log", "-1", "--format=%s", "feat/x"]),
        "amended in a terminal"
    );
}
