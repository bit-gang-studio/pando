use pando_core::{clean, CleanRequest, Repo};
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

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("work");
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
    (tmp, root)
}

#[test]
fn finds_merged_missing_and_skips_active() {
    let (_tmp, root) = fixture();
    let base = root.parent().unwrap();
    // merged: branch with a commit that main then fast-forwarded to
    let merged = base.join("wt-merged");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/merged",
            merged.to_str().unwrap(),
        ],
    );
    commit(&merged, "m1");
    git(&root, &["merge", "-q", "--ff-only", "feat/merged"]);
    // active: commits ahead, not merged
    let active = base.join("wt-active");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/active",
            active.to_str().unwrap(),
        ],
    );
    commit(&active, "a1");
    // missing: directory deleted
    let missing = base.join("wt-missing");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/missing",
            missing.to_str().unwrap(),
        ],
    );
    std::fs::remove_dir_all(&missing).unwrap();

    let repo = Repo::discover(&root).unwrap();
    let c = clean::plan(&repo).unwrap();
    let names: Vec<_> = c
        .iter()
        .map(|c| (c.branch.clone().unwrap(), c.reason))
        .collect();
    assert!(
        names.contains(&("feat/merged".into(), clean::Reason::Merged)),
        "{names:?}"
    );
    assert!(
        names.contains(&("feat/missing".into(), clean::Reason::Missing)),
        "{names:?}"
    );
    assert!(!names.iter().any(|(b, _)| b == "feat/active"), "{names:?}");
    let m = c
        .iter()
        .find(|c| c.branch.as_deref() == Some("feat/merged"))
        .unwrap();
    assert!(!m.unpushed);
    assert!(m.disk_bytes > 0);

    let steps = clean::run(
        &repo,
        &CleanRequest {
            paths: vec![merged.clone(), missing.clone()],
            delete_branches: true,
            delete_remote: false,
            skip_unpushed: true,
        },
    )
    .unwrap();
    assert!(steps.iter().all(|s| s.ok), "{steps:#?}");
    assert!(!merged.exists());
    let branches = git(&root, &["branch", "--list"]);
    assert!(
        !branches.contains("feat/merged") && !branches.contains("feat/missing"),
        "{branches}"
    );
    assert!(branches.contains("feat/active"));
    assert_eq!(
        git(
            &root,
            &["rev-parse", "--verify", "refs/pando/backup/feat/merged"]
        )
        .len(),
        40
    );
}
