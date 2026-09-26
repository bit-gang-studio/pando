//! Branch operations, history, stashes, tags on the same fixture shape as worktrees.rs.

use pando_core::{branch, history, stash, tag, Repo};
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

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

fn fixture() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let origin = base.join("origin.git");
    let root = base.join("work");
    git(&base, &["init", "-q", "--bare", "origin.git"]);
    git(&base, &["init", "-q", "-b", "main", "work"]);
    // CI runners have no global identity; core commands must find one.
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    commit(&root, "one");
    git(
        &root,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&root, &["push", "-q", "-u", "origin", "main"]);
    git(&root, &["branch", "feat/a"]);
    git(&root, &["push", "-q", "origin", "feat/a"]);
    git(&root, &["branch", "-d", "feat/a"]); // now remote-only
    git(&root, &["tag", "v0.1.0"]);
    Fx { _tmp: tmp, root }
}

#[test]
fn history_marks_base_and_lists_newest_first() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    git(&f.root, &["switch", "-q", "-c", "feat/b"]);
    commit(&f.root, "b1");
    commit(&f.root, "b2");
    let h = history::linear(&repo, "feat/b", 50).unwrap();
    let subjects: Vec<_> = h.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(subjects, ["b2", "b1", "one"]);
    assert_eq!(h.base_index, Some(2));
    assert_eq!(h.base_branch.as_deref(), Some("main"));
    assert_eq!(h.commits[0].author, "Test");

    let d = history::commit_diff(&repo, &h.commits[0].id).unwrap();
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].path, "b2");
    assert!(d.patch.contains("+b2"));
}

#[test]
fn remote_only_branch_can_be_tracked() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let remote = branch::list_remote(&repo).unwrap();
    let a = remote.iter().find(|r| r.name == "origin/feat/a").unwrap();
    assert!(!a.tracked);
    assert_eq!(a.short, "feat/a");
    assert!(
        remote
            .iter()
            .find(|r| r.name == "origin/main")
            .unwrap()
            .tracked
    );

    branch::track_remote(&repo, "origin/feat/a", "feat/a").unwrap();
    let local = branch::list(&repo).unwrap();
    let a = local.iter().find(|b| b.name == "feat/a").unwrap();
    assert_eq!(a.upstream.as_deref(), Some("origin/feat/a"));
    assert_eq!(a.ahead, Some(0));
    assert!(a.last_commit.is_some());
}

#[test]
fn create_rename_delete_with_backup() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    branch::create(&repo, "feat/c", Some("main")).unwrap();
    branch::rename(&repo, "feat/c", "feat/d").unwrap();
    assert!(branch::list(&repo)
        .unwrap()
        .iter()
        .any(|b| b.name == "feat/d"));
    branch::delete(&repo, "feat/d", false).unwrap();
    assert!(!branch::list(&repo)
        .unwrap()
        .iter()
        .any(|b| b.name == "feat/d"));
    let backup = git(
        &f.root,
        &["rev-parse", "--verify", "refs/pando/backup/feat/d"],
    );
    assert_eq!(backup.len(), 40);
}

#[test]
fn switch_in_main_and_push() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    branch::create(&repo, "feat/e", None).unwrap();
    branch::switch_in_main(&repo, "feat/e").unwrap();
    assert_eq!(git(&f.root, &["branch", "--show-current"]), "feat/e");
    commit(&f.root, "e1");
    branch::push(&repo, "feat/e", "origin", false).unwrap();
    let b = branch::list(&repo).unwrap();
    let e = b.iter().find(|b| b.name == "feat/e").unwrap();
    assert_eq!(e.upstream.as_deref(), Some("origin/feat/e"));
    assert_eq!((e.ahead, e.behind), (Some(0), Some(0)));
}

#[test]
fn stash_roundtrip() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    assert!(stash::list(&repo).unwrap().is_empty());
    assert!(!stash::save(&f.root, None).unwrap());
    std::fs::write(f.root.join("one"), "changed").unwrap();
    assert!(stash::save(&f.root, Some("wip thing")).unwrap());
    let s = stash::list(&repo).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].index, 0);
    assert_eq!(s[0].branch.as_deref(), Some("main"));
    assert!(s[0].message.contains("wip thing"));
    stash::pop(&f.root, 0).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("one")).unwrap(),
        "changed"
    );
    assert!(stash::list(&repo).unwrap().is_empty());
}

#[test]
fn tags_list() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let t = tag::list(&repo).unwrap();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].name, "v0.1.0");
    assert_eq!(t[0].target.len(), 40);
}
