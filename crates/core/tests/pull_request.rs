//! Opening a pull request: the prefilled form, and the call to gh.
mod common;
use common::*;
use pando_core::github::{self, NewPullRequest};

fn req(branch: &str, base: &str, title: &str, body: &str) -> NewPullRequest {
    NewPullRequest {
        branch: branch.into(),
        base: base.into(),
        title: title.into(),
        body: body.into(),
        draft: false,
    }
}

#[test]
fn one_commit_prefills_its_message() {
    let r = repo();
    let wt = add_worktree(&r, "feat/add-login_page", "work-login");
    write(&wt, "a.txt", "a\n");
    git(&wt, &["add", "."]);
    git(
        &wt,
        &[
            "commit",
            "-q",
            "-m",
            "Add the login page\n\nIt keeps ?next=.\n\nSecond paragraph.",
        ],
    );
    let d = github::pr_draft(&r.core(), "feat/add-login_page", "origin/main").unwrap();
    assert_eq!(d.title, "Add the login page");
    assert_eq!(d.body, "It keeps ?next=.\n\nSecond paragraph.");
    assert_eq!(d.commits, 1);
}

#[test]
fn several_commits_prefill_the_branch_name_and_a_list_oldest_first() {
    let r = repo();
    let wt = add_worktree(&r, "feat/add-login_page", "work-login");
    commit(&wt, "a.txt", "a\n");
    commit(&wt, "b.txt", "b\n");
    // main moves on: its commits are not part of the pull request.
    commit(&r.root, "main.txt", "m\n");
    git(&r.root, &["push", "-q", "origin", "main"]);
    let d = github::pr_draft(&r.core(), "feat/add-login_page", "main").unwrap();
    assert_eq!(d.title, "Add login page");
    assert_eq!(d.body, "- edit a.txt\n- edit b.txt");
    assert_eq!(d.commits, 2);
}

#[test]
fn nothing_ahead_and_odd_names() {
    let r = repo();
    add_worktree(&r, "ünï/çøde", "work-x");
    let d = github::pr_draft(&r.core(), "ünï/çøde", "main").unwrap();
    assert_eq!(
        (d.title.as_str(), d.body.as_str(), d.commits),
        ("Çøde", "", 0)
    );
    assert!(github::pr_draft(&r.core(), "nope", "main").is_err());
    let e = github::pr_draft(&r.core(), "ünï/çøde", "no-such-base")
        .unwrap_err()
        .to_string();
    assert!(e.contains("No branch named no-such-base"), "{e}");
    for bad in ["--all", "", "HEAD~1"] {
        assert!(github::pr_draft(&r.core(), bad, "main").is_err(), "{bad}");
        assert!(
            github::pr_draft(&r.core(), "ünï/çøde", bad).is_err(),
            "{bad}"
        );
    }
}

/// A fake gh: records its arguments next to itself and replies with the
/// files `out`, `err` and `code` there. Shell script, so not on Windows.
#[cfg(unix)]
mod with_gh {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    fn fake_gh(r: &Repo, out: &str, err: &str, code: i32) -> PathBuf {
        let dir = r.base.join("fake-gh");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("gh");
        std::fs::write(&bin, "#!/bin/sh\nd=\"$(dirname \"$0\")\"\nfor a in \"$@\"; do printf '%s\\n<end>\\n' \"$a\"; done > \"$d/args\"\ncat \"$d/out\"\ncat \"$d/err\" >&2\nexit \"$(cat \"$d/code\")\"\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("out"), out).unwrap();
        std::fs::write(dir.join("err"), err).unwrap();
        std::fs::write(dir.join("code"), code.to_string()).unwrap();
        bin
    }
    fn args(bin: &Path) -> Option<Vec<String>> {
        let raw = std::fs::read_to_string(bin.with_file_name("args")).ok()?;
        Some(
            raw.split("\n<end>\n")
                .filter(|a| !a.is_empty())
                .map(str::to_string)
                .collect(),
        )
    }
    const URL: &str = "https://github.com/me/work/pull/7";

    #[test]
    fn creates_with_exactly_what_was_typed_and_pushes_first() {
        let r = repo();
        let wt = add_worktree(&r, "feat/x", "work-feat-x");
        commit(&wt, "a.txt", "a\n");
        let bin = fake_gh(
            &r,
            &format!("Creating pull request for feat/x into main\n{URL}\n"),
            "",
            0,
        );
        let mut q = req(
            "feat/x",
            "origin/main",
            "  -m looks like a flag  ",
            "Line one\n\n- $HOME `x` \"quoted\"\n--draft\n",
        );
        q.draft = true;
        let url = github::create_pr_with(&bin, &r.core(), &q).unwrap();
        assert_eq!(url, URL);
        assert_eq!(
            args(&bin).unwrap(),
            [
                "pr",
                "create",
                "--head=feat/x",
                "--base=main",
                "--title=-m looks like a flag",
                "--body=Line one\n\n- $HOME `x` \"quoted\"\n--draft",
                "--draft"
            ]
        );
        // It wasn't pushed before: now it is, and tracks origin.
        assert_eq!(
            git(&r.origin, &["rev-parse", "feat/x"]),
            git(&wt, &["rev-parse", "HEAD"])
        );
        assert_eq!(
            git(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/feat/x"
        );
        // Not a draft: no --draft argument of its own.
        let q = req("feat/x", "main", "Again", "");
        github::create_pr_with(&bin, &r.core(), &q).unwrap();
        assert_eq!(
            args(&bin).unwrap(),
            [
                "pr",
                "create",
                "--head=feat/x",
                "--base=main",
                "--title=Again",
                "--body="
            ]
        );
    }

    #[test]
    fn refusals_happen_before_gh_is_called() {
        let r = repo();
        let wt = add_worktree(&r, "feat/x", "work-feat-x");
        commit(&wt, "a.txt", "a\n");
        let bin = fake_gh(&r, URL, "", 0);
        let core = r.core();
        let e = |q: NewPullRequest| {
            github::create_pr_with(&bin, &core, &q)
                .unwrap_err()
                .to_string()
        };
        assert!(e(req("feat/x", "main", "   ", "b")).contains("needs a title"));
        assert!(e(req("nope", "main", "t", "b")).contains("No branch named nope"));
        assert!(e(req("main", "origin/main", "t", "b")).contains("can't be merged into itself"));
        assert!(e(req("feat/x", "--repo=evil/x", "t", "b")).contains("isn't a branch name"));
        assert!(e(req("feat/x", "", "t", "b")).contains("isn't a branch name"));
        assert!(args(&bin).is_none(), "gh was never run");
        assert!(
            !git_ok(&r.origin, &["rev-parse", "--verify", "-q", "feat/x"]),
            "and nothing was pushed"
        );
    }

    #[test]
    fn a_branch_that_cant_be_pushed_never_reaches_gh() {
        let r = repo();
        let wt = add_worktree(&r, "feat/x", "work-feat-x");
        commit(&wt, "a.txt", "a\n");
        git(&wt, &["push", "-q", "-u", "origin", "feat/x"]);
        git(&wt, &["commit", "-q", "--amend", "-m", "rewritten"]);
        let before = git(&r.origin, &["rev-parse", "feat/x"]);
        let bin = fake_gh(&r, URL, "", 0);
        assert!(github::create_pr_with(&bin, &r.core(), &req("feat/x", "main", "t", "")).is_err());
        assert!(args(&bin).is_none());
        assert_eq!(git(&r.origin, &["rev-parse", "feat/x"]), before);
    }

    #[test]
    fn ghs_failures_become_plain_reasons() {
        let r = repo();
        let wt = add_worktree(&r, "feat/x", "work-feat-x");
        commit(&wt, "a.txt", "a\n");
        let core = r.core();
        let q = req("feat/x", "main", "t", "");
        let fail = |err: &str| {
            let bin = fake_gh(&r, "", err, 1);
            github::create_pr_with(&bin, &core, &q)
                .unwrap_err()
                .to_string()
        };
        assert_eq!(fail("a pull request for branch \"feat/x\" into branch \"main\" already exists:\nhttps://github.com/me/work/pull/3\n"), "feat/x already has a pull request.");
        assert!(
            fail("To get started with GitHub CLI, please run:  gh auth login\n")
                .contains("Run gh auth login")
        );
        assert!(fail("pull request create failed: GraphQL: No commits between main and feat/x (createPullRequest)\n").contains("main already has everything on feat/x"));
        assert_eq!(
            fail("\n  GraphQL: Something new and odd\nmore\n"),
            "GitHub didn't create the pull request: GraphQL: Something new and odd"
        );
        assert_eq!(
            fail(""),
            "GitHub didn't create the pull request: gh pr create failed"
        );
    }

    #[test]
    fn a_branch_tracking_another_name_uses_that_name_as_the_head() {
        let r = repo();
        let wt = add_worktree(&r, "local-name", "work-local");
        commit(&wt, "a.txt", "a\n");
        git(
            &wt,
            &["push", "-q", "origin", "local-name:refs/heads/their-name"],
        );
        git(
            &wt,
            &[
                "branch",
                "-q",
                "--set-upstream-to=origin/their-name",
                "local-name",
            ],
        );
        let bin = fake_gh(&r, URL, "", 0);
        github::create_pr_with(&bin, &r.core(), &req("local-name", "main", "t", "")).unwrap();
        assert!(args(&bin)
            .unwrap()
            .contains(&"--head=their-name".to_string()));
    }
}
