use pando_core::{watch, Repo};
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

fn git(cwd: &Path, args: &[&str]) {
    let ok = Command::new("git")
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
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

#[test]
fn fires_for_tracked_changes_not_ignored_ones() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
    std::fs::write(root.join("a.txt"), "a").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "one"]);
    std::fs::create_dir(root.join("build")).unwrap();

    let repo = Repo::discover(&root).unwrap();
    let (tx, rx) = mpsc::channel();
    let _w = watch::watch(&repo, &[root.clone()], move || {
        let _ = tx.send(());
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    // Drain anything from setup.
    while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}

    std::fs::write(root.join("build/out.bin"), "x").unwrap();
    assert!(
        rx.recv_timeout(Duration::from_millis(1500)).is_err(),
        "ignored file should not fire"
    );

    std::fs::write(root.join("a.txt"), "changed").unwrap();
    assert!(
        rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        "tracked change should fire"
    );
}
