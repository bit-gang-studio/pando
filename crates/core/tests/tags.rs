//! The list of tags, and getting a deleted one back.
mod common;
use common::*;
use pando_core::tag;

#[test]
fn lists_every_kind_newest_first_with_what_each_points_at() {
    let r = repo();
    let root = &r.root;
    let first = r.tip("HEAD");
    git(
        root,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e",
            "tag",
            "-a",
            "v1.0.0",
            "-m",
            "First release\n\nNotes.",
            &first,
        ],
    );
    commit(root, "a.txt", "a\n");
    let second = r.tip("HEAD");
    git(root, &["tag", "v1.1.0"]);
    git(root, &["tag", "rel/ünï-🎉", &first]);
    // A tag of a tag, and a tag on a file's contents (legal, and not a commit).
    git(
        root,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e",
            "tag",
            "-a",
            "nested",
            "-m",
            "tag of a tag",
            "v1.0.0",
        ],
    );
    git(root, &["tag", "blob-tag", "HEAD:a.txt"]);
    let tags = tag::list(&r.core()).unwrap();
    let get = |n: &str| {
        tags.iter()
            .find(|t| t.name == n)
            .unwrap_or_else(|| panic!("no {n}"))
    };
    assert!(
        tags.iter().all(|t| t.name != "blob-tag"),
        "a tag on a file isn't listed"
    );
    assert_eq!(tags.len(), 4);

    let v1 = get("v1.0.0");
    assert!(v1.annotated);
    assert_eq!(
        (v1.target.as_str(), v1.summary.as_str()),
        (first.as_str(), "First release")
    );
    assert_ne!(v1.object, first, "an annotated tag has its own object");
    let v11 = get("v1.1.0");
    assert!(!v11.annotated);
    assert_eq!(
        (
            v11.target.as_str(),
            v11.object.as_str(),
            v11.summary.as_str()
        ),
        (second.as_str(), second.as_str(), "edit a.txt")
    );
    assert_eq!(get("rel/ünï-🎉").target, first);
    assert_eq!(
        get("nested").target,
        first,
        "peeled all the way to the commit"
    );
    assert!(
        tags.windows(2).all(|w| w[0].time >= w[1].time),
        "newest first"
    );
}

#[test]
fn no_tags_and_an_empty_repo() {
    assert!(tag::list(&repo().core()).unwrap().is_empty());
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q", "-b", "main", "empty"]);
    let core = pando_core::Repo::discover(&tmp.path().join("empty")).unwrap();
    assert!(tag::list(&core).unwrap().is_empty());
}

#[test]
fn a_thousand_tags_list_in_one_quick_call() {
    let r = repo();
    let tip = r.tip("HEAD");
    let refs: String = (0..1000)
        .map(|i| format!("create refs/tags/v0.{i}.0 {tip}\n"))
        .collect();
    use std::io::Write;
    let mut c = std::process::Command::new("git")
        .current_dir(&r.root)
        .args(["update-ref", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(refs.as_bytes()).unwrap();
    assert!(c.wait().unwrap().success());
    let start = std::time::Instant::now();
    let tags = tag::list(&r.core()).unwrap();
    assert_eq!(tags.len(), 1000);
    assert!(
        start.elapsed().as_secs_f32() < 3.0,
        "took {:?}",
        start.elapsed()
    );
    // Made in the same second: the higher version comes first.
    assert_eq!(tags[0].name, "v0.999.0");
}

#[test]
fn a_deleted_tag_comes_back_exactly_annotated_or_not() {
    let r = repo();
    let core = r.core();
    git(
        &r.root,
        &[
            "-c",
            "user.name=Tagger",
            "-c",
            "user.email=t@e",
            "tag",
            "-a",
            "v1",
            "-m",
            "Release one\n\nWith notes.",
        ],
    );
    git(&r.root, &["tag", "light"]);
    let before = git(&r.root, &["cat-file", "-p", "v1"]);
    let tags = tag::list(&core).unwrap();
    for t in &tags {
        tag::delete(&core, &t.name).unwrap();
    }
    assert!(tag::list(&core).unwrap().is_empty());
    for t in &tags {
        tag::restore(&core, &t.name, &t.object).unwrap();
    }
    assert_eq!(
        git(&r.root, &["cat-file", "-p", "v1"]),
        before,
        "message, tagger and date are all back"
    );
    assert_eq!(tag::list(&core).unwrap(), tags);
}

#[test]
fn restore_never_overwrites_and_refuses_bad_input() {
    let r = repo();
    let core = r.core();
    let old = r.tip("HEAD");
    git(&r.root, &["tag", "v1"]);
    tag::delete(&core, "v1").unwrap();
    // Someone makes a new v1 on a newer commit before Undo is clicked.
    commit(&r.root, "a.txt", "a\n");
    git(&r.root, &["tag", "v1"]);
    let now = r.tip("v1");
    let e = tag::restore(&core, "v1", &old).unwrap_err().to_string();
    assert_eq!(e, "A tag named v1 exists again. Nothing was restored.");
    assert_eq!(r.tip("v1"), now);
    for (name, object) in [
        ("-x", old.as_str()),
        ("", old.as_str()),
        ("a b", old.as_str()),
        ("ok", ""),
        ("ok", "HEAD"),
        ("ok", "--stdin"),
        ("ok", "zzzz"),
    ] {
        assert!(
            tag::restore(&core, name, object).is_err(),
            "{name:?} {object:?}"
        );
    }
    assert!(!git_ok(
        &r.root,
        &["rev-parse", "--verify", "-q", "refs/tags/ok"]
    ));
}
