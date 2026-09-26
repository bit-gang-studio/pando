use pando_core::{conflict, operation, sync, OpKind, Repo, Side};
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
fn write(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

/// main and feat/y both edit a.txt; the rebase of feat/y onto main conflicts.
fn paused() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("work");
    git(&base, &["init", "-q", "-b", "main", "work"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    write(&root, "a.txt", "line\n");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "init"]);
    let wt = base.join("wt");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/y",
            wt.to_str().unwrap(),
        ],
    );
    write(&wt, "a.txt", "theirs\n");
    git(&wt, &["commit", "-q", "-am", "feat edit"]);
    write(&root, "a.txt", "ours\n");
    git(&root, &["commit", "-q", "-am", "main edit"]);
    let repo = Repo::discover(&root).unwrap();
    let r = sync::rebase_onto(&repo, &wt, "feat/y", "main").unwrap();
    assert!(!r.ok);
    (tmp, root, wt)
}

#[test]
fn detect_and_read_sides() {
    let (_t, _root, wt) = paused();
    let op = operation::detect(&wt).unwrap().unwrap();
    assert_eq!(op.kind, OpKind::Rebase);
    assert_eq!((op.applied, op.total), (1, 1));
    assert_eq!(op.conflicted, vec!["a.txt"]);
    assert!(op.head_label.contains("main"), "{}", op.head_label);
    assert!(
        op.incoming_label.contains("feat/y"),
        "{}",
        op.incoming_label
    );

    let f = conflict::file(&wt, "a.txt").unwrap();
    assert_eq!(f.ours, "ours\n");
    assert_eq!(f.theirs, "theirs\n");
    assert_eq!(f.base.as_deref(), Some("line\n"));
    assert!(f.working.contains("<<<<<<<"));
    assert!(!f.binary);
}

#[test]
fn take_both_then_continue() {
    let (_t, root, wt) = paused();
    conflict::take(&wt, "a.txt", Side::Both).unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "ours\ntheirs\n"
    );
    let op = operation::detect(&wt).unwrap().unwrap();
    assert!(op.conflicted.is_empty());
    assert_eq!(op.resolved, vec!["a.txt"]);
    let after = operation::continue_op(&wt).unwrap();
    assert!(after.is_none(), "rebase finished");
    assert_eq!(
        git(&wt, &["log", "--format=%s", "-2"]),
        "feat edit\nmain edit"
    );
    assert_eq!(
        git(&root, &["rev-parse", "main"]),
        git(&wt, &["rev-parse", "HEAD~1"])
    );
}

#[test]
fn take_theirs_resolve_and_reset() {
    let (_t, _root, wt) = paused();
    conflict::take(&wt, "a.txt", Side::Theirs).unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "theirs\n"
    );
    conflict::reset(&wt, "a.txt").unwrap();
    assert!(std::fs::read_to_string(wt.join("a.txt"))
        .unwrap()
        .contains("<<<<<<<"));
    assert_eq!(
        operation::detect(&wt).unwrap().unwrap().conflicted,
        vec!["a.txt"]
    );
    conflict::resolve(&wt, "a.txt", "hand merged\n").unwrap();
    assert!(operation::continue_op(&wt).unwrap().is_none());
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "hand merged\n"
    );
}

#[test]
fn continue_refuses_with_conflicts_left() {
    let (_t, _root, wt) = paused();
    assert!(operation::continue_op(&wt).is_err());
    operation::abort(&wt).unwrap();
    assert!(operation::detect(&wt).unwrap().is_none());
}
