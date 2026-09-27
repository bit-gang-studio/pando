//! The repo list file. One test, so PANDO_CONFIG_DIR can't leak into others.
mod common;
use common::*;
use pando_core::user_config;

#[test]
fn repo_list_add_remove_and_bad_input() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("PANDO_CONFIG_DIR", dir.path());
    assert!(
        user_config::load().unwrap().repos.is_empty(),
        "missing file is empty"
    );

    let r = repo();
    let c = user_config::add_repo(&r.root).unwrap();
    assert_eq!(c.repos.len(), 1);
    // Same repo again, or through a subfolder or a worktree: still one entry.
    write(&r.root, "sub/x.txt", "x\n");
    user_config::add_repo(&r.root.join("sub")).ok();
    let wt = add_worktree(&r, "feat/x", "wt");
    user_config::add_repo(&wt).ok();
    user_config::add_repo(&r.root).unwrap();
    let repos = user_config::load().unwrap().repos;
    assert_eq!(repos.len(), 1, "{repos:?}");

    // A folder that isn't a repo is refused.
    let not_repo = tempfile::tempdir().unwrap();
    assert!(user_config::add_repo(not_repo.path()).is_err());

    // A corrupt file doesn't crash the app; it reads as empty.
    std::fs::write(dir.path().join("config.json"), "{ not json").unwrap();
    assert!(user_config::load().unwrap().repos.is_empty());

    user_config::add_repo(&r.root).unwrap();
    let c = user_config::remove_repo(&r.root).unwrap();
    assert!(c.repos.is_empty());
}
