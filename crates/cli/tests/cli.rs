//! Runs the real `pando` binary against real repos.
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(cwd)
        .args([
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn pando(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_pando"))
        .current_dir(cwd)
        .args(args)
        .output()
        .unwrap()
}

fn ok(cwd: &Path, args: &[&str]) -> String {
    let o = pando(cwd, args);
    assert!(
        o.status.success(),
        "pando {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

/// Fails with exit 1 and a one-line "error: ..." message, never a panic.
fn fails(cwd: &Path, args: &[&str]) -> String {
    let o = pando(cwd, args);
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    assert_eq!(
        o.status.code(),
        Some(1),
        "pando {args:?} should fail: {err}"
    );
    assert!(err.starts_with("error: "), "{err}");
    assert!(!err.contains("panicked"), "{err}");
    err
}

fn repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("proj");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "one"]);
    (tmp, root)
}

#[test]
fn add_list_switch_remove() {
    let (_t, root) = repo();
    let out = ok(&root, &["add", "feat/x"]);
    let path = root.parent().unwrap().join("proj-feat-x");
    assert_eq!(out, format!("added {}", path.display()));
    assert!(path.is_dir());

    let list = ok(&root, &["list"]);
    assert!(
        list.contains("feat/x") && list.contains(&path.display().to_string()),
        "{list}"
    );
    let json: serde_json::Value = serde_json::from_str(&ok(&root, &["list", "--json"])).unwrap();
    assert_eq!(json["branches"].as_array().unwrap().len(), 2);

    assert_eq!(ok(&root, &["switch", "feat/x"]), path.display().to_string());
    // By path too, and from inside the worktree.
    assert_eq!(
        ok(&path, &["switch", path.to_str().unwrap()]),
        path.display().to_string()
    );

    ok(&root, &["remove", "feat/x"]);
    assert!(!path.exists());
    assert!(
        git(&root, &["branch", "--list", "feat/x"]).contains("feat/x"),
        "branch kept"
    );
}

#[test]
fn adding_twice_fails_cleanly() {
    let (_t, root) = repo();
    ok(&root, &["add", "feat/x"]);
    fails(&root, &["add", "feat/x"]);
    fails(&root, &["add", "--existing", "no-such-branch"]);
    fails(&root, &["add", "bad..name"]);
}

#[test]
fn removing_a_dirty_worktree_needs_force() {
    let (_t, root) = repo();
    ok(&root, &["add", "feat/x"]);
    let path = root.parent().unwrap().join("proj-feat-x");
    std::fs::write(path.join("a.txt"), "unsaved\n").unwrap();
    fails(&root, &["remove", "feat/x"]);
    assert_eq!(
        std::fs::read_to_string(path.join("a.txt")).unwrap(),
        "unsaved\n"
    );
    ok(&root, &["remove", "--force", "feat/x"]);
    assert!(!path.exists());
    let snap = git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/pando/snapshots/",
        ],
    );
    assert_eq!(
        git(&root, &["show", &format!("{snap}:a.txt")]),
        "unsaved",
        "force keeps a copy"
    );
}

#[test]
fn unknown_targets_and_non_repos_fail_cleanly() {
    let (_t, root) = repo();
    fails(&root, &["switch", "nope"]);
    fails(&root, &["remove", "nope"]);
    let elsewhere = tempfile::tempdir().unwrap();
    let err = fails(elsewhere.path(), &["list"]);
    assert!(err.contains("not a git repository"), "{err}");
    ok(
        elsewhere.path(),
        &["--repo", root.to_str().unwrap(), "list"],
    );
}

#[test]
fn shell_init_is_valid_shell() {
    for (shell, bin) in [("bash", "bash"), ("zsh", "zsh")] {
        let script = ok(Path::new("."), &["shell-init", shell]);
        assert!(script.contains("pcd"));
        let has_shell = Command::new(bin).arg("-c").arg("true").output().is_ok();
        if has_shell && !cfg!(windows) {
            let o = Command::new(bin)
                .arg("-n")
                .arg("-c")
                .arg(&script)
                .output()
                .unwrap();
            assert!(
                o.status.success(),
                "{shell}: {}",
                String::from_utf8_lossy(&o.stderr)
            );
        }
    }
    assert!(ok(Path::new("."), &["shell-init", "fish"]).contains("function pcd"));
}

#[test]
fn doctor_reports_git() {
    let json: serde_json::Value =
        serde_json::from_str(&ok(Path::new("."), &["doctor", "--json"])).unwrap();
    assert_eq!(json["git_ok"], true);
    assert_eq!(json["min_git"], "2.39");
}
