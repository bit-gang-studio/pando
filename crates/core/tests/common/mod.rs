//! Shared test helpers: real git repos in temp dirs.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

/// Run git and return trimmed stdout. Panics on failure.
pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = run(cwd, args);
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Run git; true if it succeeded.
pub fn git_ok(cwd: &Path, args: &[&str]) -> bool {
    run(cwd, args).status.success()
}

fn run(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
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
        .unwrap()
}

pub fn write(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, body).unwrap();
}

pub fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

/// Write `name` with `body` and commit it.
pub fn commit(cwd: &Path, name: &str, body: &str) {
    write(cwd, name, body);
    git(cwd, &["add", "--", name]);
    git(cwd, &["commit", "-q", "-m", &format!("edit {name}")]);
}

pub struct Repo {
    _tmp: tempfile::TempDir,
    /// The folder holding the repo, its bare origin and any sibling worktrees.
    pub base: PathBuf,
    pub root: PathBuf,
    pub origin: PathBuf,
}

impl Repo {
    pub fn core(&self) -> pando_core::Repo {
        pando_core::Repo::discover(&self.root).unwrap()
    }
    pub fn tip(&self, rev: &str) -> String {
        git(&self.root, &["rev-parse", rev])
    }
    pub fn sibling(&self, name: &str) -> PathBuf {
        self.base.join(name)
    }
}

/// A repo named `name` on `main` with one commit, pushed to a bare `origin`.
pub fn repo_named(name: &str) -> Repo {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join(name);
    let origin = base.join("origin.git");
    git(&base, &["init", "-q", "--bare", "origin.git"]);
    git(&base, &["init", "-q", "-b", "main", name]);
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ] {
        git(&root, &["config", k, v]);
    }
    commit(&root, "README.md", "hello\n");
    git(
        &root,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&root, &["push", "-q", "-u", "origin", "main"]);
    Repo {
        _tmp: tmp,
        base,
        root,
        origin,
    }
}

pub fn repo() -> Repo {
    repo_named("work")
}

/// Add a linked worktree for a new branch at `base/<folder>`.
pub fn add_worktree(r: &Repo, branch: &str, folder: &str) -> PathBuf {
    let p = r.base.join(folder);
    git(
        &r.root,
        &["worktree", "add", "-q", "-b", branch, p.to_str().unwrap()],
    );
    p
}

/// Every ref under refs/pando/.
pub fn pando_refs(r: &Repo) -> Vec<String> {
    let out = git(
        &r.root,
        &["for-each-ref", "--format=%(refname)", "refs/pando/"],
    );
    out.lines().map(str::to_string).collect()
}
