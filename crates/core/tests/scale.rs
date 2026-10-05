//! Big repos: the counts stay right, and the first screen stays fast.
mod common;
use common::*;
use pando_core::{branch, merge, overview};
use std::io::Write;
use std::process::{Command, Stdio};

fn row<'a>(o: &'a overview::Overview, name: &str) -> &'a overview::BranchRow {
    o.branches
        .iter()
        .find(|b| b.branch.name == name)
        .unwrap_or_else(|| panic!("no {name}"))
}

#[test]
fn ahead_and_behind_counts_are_right_in_every_shape() {
    let r = repo();
    let root = &r.root;
    // ahead of the base only
    git(root, &["switch", "-q", "-c", "ahead"]);
    commit(root, "a1.txt", "1\n");
    commit(root, "a2.txt", "2\n");
    // pushed, then one more: ahead 1 of its upstream
    git(root, &["push", "-q", "-u", "origin", "ahead"]);
    commit(root, "a3.txt", "3\n");
    // sitting on an old commit of main: nothing ahead
    git(root, &["switch", "-q", "main"]);
    git(root, &["branch", "old"]);
    commit(root, "m1.txt", "m\n");
    commit(root, "m2.txt", "m\n");
    git(root, &["push", "-q", "origin", "main"]);
    // behind its upstream by 2, ahead by 0
    git(root, &["branch", "-q", "--track", "lagging", "origin/main"]);
    git(root, &["branch", "-q", "-f", "lagging", "old"]);
    // diverged from its upstream: ahead 1, behind 2
    git(root, &["switch", "-q", "-c", "diverged", "old"]);
    commit(root, "d.txt", "d\n");
    git(root, &["branch", "-q", "--set-upstream-to=origin/main"]);
    // upstream deleted on the remote
    git(root, &["switch", "-q", "-c", "gone", "main"]);
    git(root, &["push", "-q", "-u", "origin", "gone"]);
    git(root, &["push", "-q", "origin", "--delete", "gone"]);
    // an unrelated history
    git(root, &["switch", "-q", "--orphan", "island"]);
    commit(root, "island.txt", "i\n");
    git(root, &["switch", "-q", "main"]);
    // odd names
    git(root, &["branch", "ünï/çøde-🎉", "ahead"]);

    let o = overview::load(&r.core()).unwrap();
    let ahead = |n: &str| row(&o, n).ahead_of_base;
    assert_eq!(ahead("main"), Some(0));
    assert_eq!(ahead("ahead"), Some(3));
    assert_eq!(ahead("old"), Some(0));
    assert_eq!(ahead("lagging"), Some(0));
    assert_eq!(ahead("diverged"), Some(1));
    assert_eq!(ahead("gone"), Some(0));
    assert_eq!(ahead("island"), Some(1));
    assert_eq!(ahead("ünï/çøde-🎉"), Some(3));

    let up = |n: &str| {
        let b = &row(&o, n).branch;
        (b.upstream.as_deref(), b.ahead, b.behind)
    };
    assert_eq!(up("main"), (Some("origin/main"), Some(0), Some(0)));
    assert_eq!(up("ahead"), (Some("origin/ahead"), Some(1), Some(0)));
    assert_eq!(up("lagging"), (Some("origin/main"), Some(0), Some(2)));
    assert_eq!(up("diverged"), (Some("origin/main"), Some(1), Some(2)));
    assert_eq!(up("old"), (None, None, None));
    assert_eq!(up("island"), (None, None, None));
    // The upstream is set but no longer exists: no counts, not zeros.
    assert_eq!(
        (row(&o, "gone").branch.ahead, row(&o, "gone").branch.behind),
        (None, None)
    );

    // The same numbers, asked the other ways.
    let p = merge::preflight(&r.core(), None, "diverged", "origin/main").unwrap();
    assert_eq!((p.ahead, p.behind), (1, 2));
    let remotes = branch::list_remote(&r.core()).unwrap();
    let tracked = |n: &str| remotes.iter().find(|b| b.name == n).map(|b| b.tracked);
    assert_eq!(tracked("origin/main"), Some(true));
    assert_eq!(tracked("origin/ahead"), Some(true));
}

#[test]
fn no_remote_and_no_commits_still_load() {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q", "-b", "main", "solo"]);
    let root = tmp.path().join("solo");
    let core = pando_core::Repo::discover(&root).unwrap();
    assert!(overview::load(&core).unwrap().branches.is_empty());
    for (k, v) in [
        ("user.name", "T"),
        ("user.email", "t@e"),
        ("commit.gpgsign", "false"),
    ] {
        git(&root, &["config", k, v]);
    }
    commit(&root, "a.txt", "a\n");
    git(&root, &["switch", "-q", "-c", "feat"]);
    commit(&root, "b.txt", "b\n");
    let core = pando_core::Repo::discover(&root).unwrap();
    let o = overview::load(&core).unwrap();
    assert_eq!(row(&o, "feat").ahead_of_base, Some(1));
    assert_eq!(row(&o, "main").ahead_of_base, Some(0));
}

/// 20,000 commits in one line, 300 branches spread along it, ten of them
/// tracking the tip from far behind, three with work of their own.
fn big() -> Repo {
    let r = repo();
    let mut script = String::new();
    for i in 1..=20_000u32 {
        script.push_str(&format!(
            "commit refs/heads/main\nmark :{i}\ncommitter T <t@e> {} +0000\ndata 2\nc\n{}M 100644 inline f.txt\ndata {}\n{i}\n\n",
            1_600_000_000 + i,
            if i == 1 { "from refs/heads/main^0\n".to_string() } else { String::new() },
            i.to_string().len() + 1,
        ));
    }
    for b in 0..300u32 {
        script.push_str(&format!(
            "reset refs/heads/topic/t{b}\nfrom :{}\n\n",
            20_000 - b * 60
        ));
    }
    for b in 0..10u32 {
        script.push_str(&format!(
            "reset refs/heads/lag/l{b}\nfrom :{}\n\n",
            19_000 - b * 1500
        ));
    }
    let mut child = Command::new("git")
        .current_dir(&r.root)
        .args(["fast-import", "--quiet", "--force"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
    git(&r.root, &["reset", "-q", "--hard", "main"]);
    git(&r.root, &["push", "-q", "origin", "main"]);
    for b in 0..10 {
        git(
            &r.root,
            &[
                "branch",
                "-q",
                "--set-upstream-to=origin/main",
                &format!("lag/l{b}"),
            ],
        );
    }
    for b in 0..3 {
        let wt = add_worktree(&r, &format!("work/w{b}"), &format!("work-w{b}"));
        commit(&wt, "mine.txt", "x\n");
    }
    r
}

#[test]
fn the_first_screen_stays_fast_with_many_branches_and_a_long_history() {
    let r = big();
    let core = r.core();
    let start = std::time::Instant::now();
    let o = overview::load_quick(&core).unwrap();
    let took = start.elapsed();
    assert_eq!(o.branches.len(), 314);
    assert_eq!(row(&o, "topic/t299").ahead_of_base, Some(0));
    assert_eq!(row(&o, "work/w1").ahead_of_base, Some(1));
    assert_eq!(
        (
            row(&o, "lag/l9").branch.ahead,
            row(&o, "lag/l9").branch.behind
        ),
        (Some(0), Some(14_500))
    );
    // Walking each branch's history ourselves took well over 10 seconds here.
    // Generous, so a slow CI machine passes and a return to that doesn't.
    assert!(took.as_secs_f32() < 6.0, "overview took {took:?}");
}
