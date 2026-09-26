//! Fixture: a bare `origin`, a main worktree on `main`, and two linked
//! worktrees on `feat/a` and `feat/b`. `main` is 1 ahead and 1 behind origin.

use pando_core::{branch, worktree, AddWorktree, Repo, WorktreeKind};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(cwd)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(cwd: &Path, name: &str) {
    std::fs::write(cwd.join(name), name).unwrap();
    git(cwd, &["add", "."]);
    git(cwd, &["commit", "-q", "-m", name]);
}

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    wt_a: PathBuf,
    wt_b: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let origin = base.join("origin.git");
    let root = base.join("work");
    git(&base, &["init", "-q", "--bare", "origin.git"]);
    git(&base, &["init", "-q", "-b", "main", "work"]);
    // CI runners have no global identity; core commands must find one.
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    commit(&root, "one");
    git(
        &root,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&root, &["push", "-q", "-u", "origin", "main"]);

    let wt_a = base.join("wt-a");
    let wt_b = base.join("wt-b");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/a",
            wt_a.to_str().unwrap(),
        ],
    );
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/b",
            wt_b.to_str().unwrap(),
        ],
    );
    commit(&wt_a, "a1");

    // main: 1 ahead (local commit) and 1 behind (feat/b pushed to origin main).
    commit(&root, "two");
    commit(&wt_b, "b1");
    git(&wt_b, &["push", "-q", "origin", "feat/b:main"]);
    git(&root, &["fetch", "-q", "origin"]);

    Fixture {
        _tmp: tmp,
        root,
        wt_a,
        wt_b,
    }
}

#[test]
fn discover_from_linked_worktree_finds_main_root() {
    let f = fixture();
    let repo = Repo::discover(&f.wt_a).unwrap();
    assert_eq!(repo.root, f.root);
    assert_eq!(repo.common_git_dir, f.root.join(".git"));
    assert_eq!(repo.default_branch.as_deref(), Some("main"));
    assert!(!repo.bare);
}

#[test]
fn discover_outside_repo_fails() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(Repo::discover(tmp.path()).is_err());
}

#[test]
fn lists_three_worktrees() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let ws = worktree::list(&repo).unwrap();
    assert_eq!(ws.len(), 3);
    assert_eq!(ws[0].kind, WorktreeKind::Main);
    assert_eq!(ws[0].path, f.root);
    assert_eq!(ws[0].branch.as_deref(), Some("main"));
    let a = ws.iter().find(|w| w.path == f.wt_a).unwrap();
    assert_eq!(a.kind, WorktreeKind::Linked);
    assert_eq!(a.branch.as_deref(), Some("feat/a"));
    assert!(a.head.is_some());
    assert!(a.locked.is_none());
    assert!(a.prunable.is_none());
}

#[test]
fn add_new_branch_then_remove_writes_backup() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let path = f.root.parent().unwrap().join("wt-c");
    let w = worktree::add(
        &repo,
        &AddWorktree {
            path: path.clone(),
            branch: "feat/c".into(),
            base: Some("main".into()),
            create_branch: true,
        },
    )
    .unwrap();
    assert_eq!(w.branch.as_deref(), Some("feat/c"));
    assert_eq!(worktree::list(&repo).unwrap().len(), 4);

    worktree::remove(&repo, &path, false).unwrap();
    assert_eq!(worktree::list(&repo).unwrap().len(), 3);
    let backup = git(
        &f.root,
        &["rev-parse", "--verify", "refs/pando/backup/feat/c"],
    );
    let tip = git(&f.root, &["rev-parse", "--verify", "refs/heads/feat/c"]);
    assert_eq!(backup, tip);
}

#[test]
fn add_existing_branch() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    git(&f.root, &["branch", "-q", "feat/d", "main"]);
    let path = f.root.parent().unwrap().join("wt-d");
    let w = worktree::add(
        &repo,
        &AddWorktree {
            path,
            branch: "feat/d".into(),
            base: None,
            create_branch: false,
        },
    )
    .unwrap();
    assert_eq!(w.branch.as_deref(), Some("feat/d"));
}

#[test]
fn prune_drops_missing_worktree() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    std::fs::remove_dir_all(&f.wt_b).unwrap();
    let ws = worktree::list(&repo).unwrap();
    assert!(ws
        .iter()
        .find(|w| w.path == f.wt_b)
        .unwrap()
        .prunable
        .is_some());
    assert_eq!(worktree::prune(&repo).unwrap(), 1);
    assert_eq!(worktree::list(&repo).unwrap().len(), 2);
}

#[test]
fn lock_and_unlock() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    worktree::lock(&repo, &f.wt_a, Some("busy")).unwrap();
    let ws = worktree::list(&repo).unwrap();
    let a = ws.iter().find(|w| w.path == f.wt_a).unwrap();
    assert_eq!(a.locked.as_deref(), Some("busy"));
    worktree::unlock(&repo, &f.wt_a).unwrap();
    let ws = worktree::list(&repo).unwrap();
    assert!(ws
        .iter()
        .find(|w| w.path == f.wt_a)
        .unwrap()
        .locked
        .is_none());
}

#[test]
fn branches_with_upstream_and_checkout() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let bs = branch::list(&repo).unwrap();
    let names: Vec<_> = bs.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["feat/a", "feat/b", "main"]);

    let main = bs.iter().find(|b| b.name == "main").unwrap();
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!(main.ahead, Some(1));
    assert_eq!(main.behind, Some(1));
    assert_eq!(main.checked_out_in.as_deref(), Some(f.root.as_path()));

    let a = bs.iter().find(|b| b.name == "feat/a").unwrap();
    assert_eq!(a.upstream, None);
    assert_eq!(a.ahead, None);
    assert_eq!(a.checked_out_in.as_deref(), Some(f.wt_a.as_path()));
    assert_eq!(a.tip.len(), 40);
}

#[test]
fn types_round_trip_through_json() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let ws = worktree::list(&repo).unwrap();
    let json = serde_json::to_string(&ws).unwrap();
    let back: Vec<pando_core::Worktree> = serde_json::from_str(&json).unwrap();
    assert_eq!(ws, back);
    let repo_json = serde_json::to_string(&repo).unwrap();
    assert_eq!(repo, serde_json::from_str::<Repo>(&repo_json).unwrap());
}

#[test]
fn create_uses_config_hooks_and_port() {
    let f = fixture();
    std::fs::write(
        f.root.join(".pando.toml"),
        r#"
[worktree]
location = "../ws/{branch_slug}"
[hooks]
post_create = ["echo hi > hook.txt", "echo $PANDO_BRANCH > branch.txt"]
[runtime]
port = { env = "PORT", start = 4100 }
"#,
    )
    .unwrap();
    let repo = Repo::discover(&f.root).unwrap();
    let created = worktree::create(
        &repo,
        &pando_core::CreateWorktree {
            branch: "feat/x".into(),
            base: None,
            path: None,
            existing_branch: false,
            run_hooks: true,
        },
    )
    .unwrap();
    let expected = dunce::canonicalize(f.root.parent().unwrap().join("ws").join("feat-x")).unwrap();
    assert_eq!(created.worktree.path, expected);
    assert_eq!(created.port, Some(4100));
    assert_eq!(created.hooks.len(), 2);
    assert!(created.hooks.iter().all(|h| h.ok()));
    assert!(expected.join("hook.txt").exists());

    // Second worktree gets the next port; removing frees it.
    let second = worktree::create(
        &repo,
        &pando_core::CreateWorktree {
            branch: "feat/y".into(),
            base: None,
            path: None,
            existing_branch: false,
            run_hooks: false,
        },
    )
    .unwrap();
    assert_eq!(second.port, Some(4101));
    worktree::remove(&repo, &created.worktree.path, true).unwrap();
    assert_eq!(
        pando_core::runtime::port_for(&repo, "feat/x").unwrap(),
        None
    );
}

#[test]
fn failing_hook_stops_and_reports() {
    let f = fixture();
    std::fs::write(
        f.root.join(".pando.toml"),
        "[worktree]\nlocation = \"../ws/{branch_slug}\"\n[hooks]\npost_create = [\"exit 3\", \"echo never\"]\n",
    )
    .unwrap();
    let repo = Repo::discover(&f.root).unwrap();
    let created = worktree::create(
        &repo,
        &pando_core::CreateWorktree {
            branch: "feat/z".into(),
            base: None,
            path: None,
            existing_branch: false,
            run_hooks: true,
        },
    )
    .unwrap();
    assert_eq!(created.hooks.len(), 1);
    assert_eq!(created.hooks[0].exit_code, Some(3));
}
