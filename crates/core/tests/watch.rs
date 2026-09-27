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
    let _w = watch::watch(&repo, std::slice::from_ref(&root), move || {
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

fn setup() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    mpsc::Receiver<()>,
    watch::RepoWatcher,
) {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.txt"), "a").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "one"]);
    let repo = Repo::discover(&root).unwrap();
    let (tx, rx) = mpsc::channel();
    let w = watch::watch(&repo, std::slice::from_ref(&root), move || {
        let _ = tx.send(());
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}
    (tmp, root, rx, w)
}

#[test]
fn a_burst_of_writes_is_one_or_two_refreshes() {
    let (_t, root, rx, _w) = setup();
    for i in 0..300 {
        std::fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
    }
    let mut n = 0;
    while rx.recv_timeout(Duration::from_millis(1500)).is_ok() {
        n += 1;
    }
    assert!((1..=3).contains(&n), "{n} refreshes for one burst");
}

#[test]
fn fires_for_deletes_renames_and_commits_from_elsewhere() {
    let (_t, root, rx, _w) = setup();
    std::fs::remove_file(root.join("a.txt")).unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok(), "delete");
    while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}

    git(&root, &["checkout", "--", "a.txt"]);
    while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}
    std::fs::rename(root.join("a.txt"), root.join("b.txt")).unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok(), "rename");
    while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}

    // A branch made by another program: only the git dir changes.
    git(&root, &["branch", "made-elsewhere"]);
    assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok(), "new ref");
}

#[test]
fn quiet_when_nothing_changes() {
    let (_t, _root, rx, _w) = setup();
    assert!(
        rx.recv_timeout(Duration::from_secs(3)).is_err(),
        "no refreshes on its own"
    );
}

#[test]
fn stops_when_dropped() {
    let (_t, root, rx, w) = setup();
    drop(w);
    std::fs::write(root.join("a.txt"), "changed").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_err());
}
