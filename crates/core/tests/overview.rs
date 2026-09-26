use pando_core::{overview, Repo};
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
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?}: {}",
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

#[test]
fn worktree_branches_first_then_others_then_remote() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root: PathBuf = base.join("work");
    git(&base, &["init", "-q", "--bare", "origin.git"]);
    git(&base, &["init", "-q", "-b", "main", "work"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    commit(&root, "one");
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            base.join("origin.git").to_str().unwrap(),
        ],
    );
    git(&root, &["push", "-q", "-u", "origin", "main"]);
    git(&root, &["branch", "zz/no-worktree"]);
    git(&root, &["branch", "remote-only"]);
    git(&root, &["push", "-q", "origin", "remote-only"]);
    git(&root, &["branch", "-D", "remote-only"]);
    let wt = base.join("wt");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/a",
            wt.to_str().unwrap(),
        ],
    );
    commit(&wt, "a1");
    std::fs::write(wt.join("dirty.txt"), "x").unwrap();

    let repo = Repo::discover(&root).unwrap();
    let o = overview::load(&repo).unwrap();
    assert_eq!(o.base.as_deref(), Some("main"));
    let names: Vec<_> = o.branches.iter().map(|r| r.branch.name.as_str()).collect();
    assert_eq!(names, ["main", "feat/a", "zz/no-worktree"]);
    assert!(o.branches[0].is_main_worktree);
    let a = &o.branches[1];
    assert!(a.worktree.is_some());
    assert_eq!(a.ahead_of_base, Some(1));
    assert_eq!(a.status.unwrap().changed(), 1);
    assert!(!a.stale);
    assert!(o.branches[2].worktree.is_none());
    assert_eq!(o.branches[2].ahead_of_base, Some(0));
    assert_eq!(o.remote_only.len(), 1);
    assert_eq!(o.remote_only[0].short, "remote-only");
}
