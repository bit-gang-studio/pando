use pando_core::{land, Destination, LandPlan, Repo};
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
fn write(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}
fn commit(cwd: &Path, name: &str) {
    write(cwd, name, name);
    git(cwd, &["add", "."]);
    git(cwd, &["commit", "-q", "-m", name]);
}

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    wt: PathBuf,
}

fn fixture() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("work");
    git(&base, &["init", "-q", "--bare", "origin.git"]);
    git(&base, &["init", "-q", "-b", "main", "work"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
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
    let wt = base.join("wt");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/x",
            wt.to_str().unwrap(),
        ],
    );
    commit(&wt, "x1");
    commit(&wt, "x2");
    commit(&root, "main-moved");
    Fx {
        _tmp: tmp,
        root,
        wt,
    }
}

fn plan(squash: bool) -> LandPlan {
    LandPlan {
        branch: "feat/x".into(),
        base: "main".into(),
        squash,
        message: Some("Land feat/x squashed".into()),
        destination: Destination::LocalMerge,
        push_base: true,
        run_hooks: true,
        remove_worktree: true,
        delete_branch: true,
        delete_remote: false,
    }
}

#[test]
fn preflight_reports_state() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let p = land::preflight(&repo, &f.wt, "feat/x", "main").unwrap();
    assert!(p.clean);
    assert_eq!((p.ahead, p.behind), (2, 1));
    assert!(!p.conflict_predicted);
    assert_eq!(p.base_checked_out_in.as_deref(), Some(f.root.as_path()));
    assert_eq!(p.base_worktree_clean, Some(true));
    assert!(p.problems.is_empty(), "{:?}", p.problems);

    write(&f.wt, "dirty.txt", "x");
    let p = land::preflight(&repo, &f.wt, "feat/x", "main").unwrap();
    assert!(!p.clean);
    assert_eq!(p.problems.len(), 1);
}

#[test]
fn preflight_predicts_conflicts() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    write(&f.wt, "one", "theirs");
    git(&f.wt, &["commit", "-q", "-am", "edit one"]);
    write(&f.root, "one", "ours");
    git(&f.root, &["commit", "-q", "-am", "edit one on main"]);
    let p = land::preflight(&repo, &f.wt, "feat/x", "main").unwrap();
    assert!(p.conflict_predicted);
    assert_eq!(p.conflict_files, vec!["one"]);
}

#[test]
fn land_squash_into_local_main_and_push() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let r = land::run(&repo, &f.wt, &plan(true)).unwrap();
    assert!(r.landed, "{:#?}", r.steps);
    assert!(r.steps.iter().all(|s| s.ok), "{:#?}", r.steps);
    assert_eq!(
        git(&f.root, &["log", "-1", "--format=%s"]),
        "Land feat/x squashed"
    );
    assert_eq!(
        git(&f.root, &["rev-list", "--count", "HEAD"]),
        "3",
        "one + main-moved + squash"
    );
    assert!(!f.wt.exists());
    assert!(!git(&f.root, &["branch", "--list"]).contains("feat/x"));
    assert_eq!(
        git(&f.root, &["rev-parse", "origin/main"]),
        git(&f.root, &["rev-parse", "main"])
    );
    assert!(r.backup_ref.is_some());
}

#[test]
fn land_keep_commits() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let mut p = plan(false);
    p.push_base = false;
    let r = land::run(&repo, &f.wt, &p).unwrap();
    assert!(r.landed, "{:#?}", r.steps);
    assert_eq!(
        git(&f.root, &["log", "--format=%s", "-3"]),
        "x2\nx1\nmain-moved"
    );
}

#[test]
fn land_stops_on_failing_hook() {
    let f = fixture();
    write(&f.root, ".pando.toml", "[hooks]\npre_land = [\"exit 2\"]\n");
    let repo = Repo::discover(&f.root).unwrap();
    let r = land::run(&repo, &f.wt, &plan(true)).unwrap();
    assert!(!r.landed);
    assert_eq!(r.steps.len(), 2);
    assert!(!r.steps[1].ok);
    assert!(f.wt.exists());
}
