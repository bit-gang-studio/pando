//! Cloning into a chosen folder.
mod common;
use common::*;
use pando_core::github;

#[test]
fn clones_into_parent_slash_name() {
    let r = repo();
    let into = tempfile::tempdir().unwrap();
    let parent = dunce::canonicalize(into.path()).unwrap();
    let url = format!("file://{}", r.origin.display());
    let dest = github::clone(&url, &parent).unwrap();
    assert_eq!(dest, parent.join("origin"));
    assert_eq!(read(&dest, "README.md"), "hello\n");
}

#[test]
fn never_clones_over_an_existing_folder() {
    let r = repo();
    let into = tempfile::tempdir().unwrap();
    let parent = dunce::canonicalize(into.path()).unwrap();
    write(&parent.join("origin"), "mine.txt", "keep\n");
    let url = format!("file://{}", r.origin.display());
    let err = github::clone(&url, &parent).unwrap_err().to_string();
    assert!(err.contains("already exists"), "{err}");
    assert_eq!(read(&parent.join("origin"), "mine.txt"), "keep\n");
}

#[test]
fn a_failed_clone_leaves_nothing_behind() {
    let into = tempfile::tempdir().unwrap();
    let parent = dunce::canonicalize(into.path()).unwrap();
    assert!(github::clone("file:///no/such/repo.git", &parent).is_err());
    assert!(
        std::fs::read_dir(&parent).unwrap().next().is_none(),
        "no half-made folder"
    );
}

#[test]
fn a_parent_that_isnt_a_folder_is_refused() {
    let r = repo();
    let url = format!("file://{}", r.origin.display());
    assert!(github::clone(&url, &r.root.join("README.md")).is_err());
    assert!(github::clone(&url, std::path::Path::new("/no/such/place")).is_err());
}
