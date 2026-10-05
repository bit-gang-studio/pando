//! Finding commits by message, author or id.
mod common;
use common::*;
use pando_core::log;
use std::path::Path;

fn commit_as(cwd: &Path, author: &str, file: &str, message: &str) -> String {
    write(cwd, file, message);
    git(cwd, &["add", "."]);
    git(
        cwd,
        &[
            "-c",
            &format!("user.name={author}"),
            "-c",
            "user.email=x@e",
            "commit",
            "-q",
            "-m",
            message,
        ],
    );
    git(cwd, &["rev-parse", "HEAD"])
}
fn subjects(l: &log::Log) -> Vec<&str> {
    l.entries.iter().map(|e| e.summary.as_str()).collect()
}

/// main: README, "Fix the login redirect" (Ana), "Add CART totals" (Sam).
/// feat/x (not merged): "Login page polish" (Sam), body mentions "redirect".
fn fixture() -> (Repo, Vec<String>) {
    let r = repo();
    let a = commit_as(&r.root, "Ana Lima", "a.txt", "Fix the login redirect");
    let b = commit_as(&r.root, "Sam Okoro", "b.txt", "Add CART totals");
    git(&r.root, &["switch", "-q", "-c", "feat/x"]);
    let c = commit_as(
        &r.root,
        "Sam Okoro",
        "c.txt",
        "Login page polish\n\nAlso tidies the redirect helper.",
    );
    git(&r.root, &["switch", "-q", "main"]);
    (r, vec![a, b, c])
}

#[test]
fn finds_by_message_in_any_case_including_the_body() {
    let (r, _) = fixture();
    let core = r.core();
    let all = log::search(&core, None, "LOGIN", 0, 50).unwrap();
    // Made in the same second, so only what's found is checked, not the order.
    let mut found = subjects(&all);
    found.sort();
    assert_eq!(found, ["Fix the login redirect", "Login page polish"]);
    assert_eq!(
        subjects(&log::search(&core, None, "  cart ", 0, 50).unwrap()),
        ["Add CART totals"]
    );
    // "redirect" is in one summary and one body.
    assert_eq!(
        log::search(&core, None, "redirect", 0, 50)
            .unwrap()
            .entries
            .len(),
        2
    );
    assert!(log::search(&core, None, "nothing like this", 0, 50)
        .unwrap()
        .entries
        .is_empty());
}

#[test]
fn stays_inside_the_branch_asked_for() {
    let (r, _) = fixture();
    let core = r.core();
    assert_eq!(
        subjects(&log::search(&core, Some("main"), "login", 0, 50).unwrap()),
        ["Fix the login redirect"]
    );
    assert_eq!(
        log::search(&core, Some("feat/x"), "login", 0, 50)
            .unwrap()
            .entries
            .len(),
        2
    );
    assert!(log::search(&core, Some("no-such-branch"), "login", 0, 50).is_err());
    for bad in ["--all", "-n1", ""] {
        assert!(
            log::search(&core, Some(bad), "login", 0, 50).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn finds_by_author_and_never_lists_a_commit_twice() {
    let (r, _) = fixture();
    let core = r.core();
    assert_eq!(
        subjects(&log::search(&core, None, "ana", 0, 50).unwrap()),
        ["Fix the login redirect"]
    );
    assert_eq!(
        log::search(&core, None, "okoro", 0, 50)
            .unwrap()
            .entries
            .len(),
        2
    );
    // Matches both the author and the message: once.
    commit_as(&r.root, "Sam Okoro", "d.txt", "Thanks Sam for the review");
    let sam = log::search(&core, None, "sam", 0, 50).unwrap();
    assert_eq!(sam.entries.len(), 3);
    assert_eq!(sam.entries[0].summary, "Thanks Sam for the review");
}

#[test]
fn finds_by_full_and_short_id_and_puts_it_first() {
    let (r, ids) = fixture();
    let core = r.core();
    let full = log::search(&core, None, &ids[0], 0, 50).unwrap();
    assert_eq!(full.entries[0].id, ids[0]);
    assert_eq!(full.entries.len(), 1);
    assert_eq!(
        log::search(&core, None, &ids[2][..7].to_uppercase(), 0, 50)
            .unwrap()
            .entries[0]
            .id,
        ids[2]
    );
    // feat/x's commit isn't on main.
    assert!(log::search(&core, Some("main"), &ids[2][..7], 0, 50)
        .unwrap()
        .entries
        .is_empty());
    assert_eq!(
        log::search(&core, Some("feat/x"), &ids[2][..7], 0, 50)
            .unwrap()
            .entries
            .len(),
        1
    );
    // Looks like an id but isn't one, and also a word in a message.
    commit_as(&r.root, "Ana Lima", "e.txt", "Remove dead beef recipes");
    assert_eq!(
        subjects(&log::search(&core, None, "beef", 0, 50).unwrap()),
        ["Remove dead beef recipes"]
    );
    assert!(log::search(&core, None, "deadbeef", 0, 50)
        .unwrap()
        .entries
        .is_empty());
}

#[test]
fn odd_input_is_taken_literally() {
    let (r, _) = fixture();
    let core = r.core();
    commit_as(
        &r.root,
        "Ünï Çøde",
        "f.txt",
        "Use a.b(c)* and [x] --all \"quoted\" $HOME 100%",
    );
    for q in [
        "a.b(c)*",
        "[x]",
        "--all",
        "\"quoted\"",
        "$HOME",
        "100%",
        "Ünï",
        "øde",
    ] {
        let got = log::search(&core, None, q, 0, 50).unwrap();
        assert_eq!(got.entries.len(), 1, "{q}");
    }
    // A regex that would match everything matches nothing as plain text.
    for q in [".*", "^", "a.b.c", "-n1", "--author=Sam"] {
        assert!(
            log::search(&core, None, q, 0, 50)
                .unwrap()
                .entries
                .is_empty(),
            "{q}"
        );
    }
    for q in ["", "   ", "two\nlines"] {
        assert!(
            log::search(&core, None, q, 0, 50)
                .unwrap()
                .entries
                .is_empty(),
            "{q:?}"
        );
    }
}

#[test]
fn pages_without_gaps_or_repeats() {
    let r = repo();
    for i in 0..7 {
        commit_as(&r.root, "Sam", &format!("f{i}.txt"), &format!("needle {i}"));
    }
    let core = r.core();
    let first = log::search(&core, None, "needle", 0, 3).unwrap();
    assert!(first.truncated);
    let second = log::search(&core, None, "needle", 3, 3).unwrap();
    assert!(second.truncated);
    let last = log::search(&core, None, "needle", 6, 3).unwrap();
    assert!(!last.truncated);
    let mut seen: Vec<String> = [first, second, last]
        .iter()
        .flat_map(|l| l.entries.iter().map(|e| e.summary.clone()))
        .collect();
    assert_eq!(seen.len(), 7);
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 7);
}

#[test]
fn an_empty_repo_has_no_matches() {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q", "-b", "main", "empty"]);
    let core = pando_core::Repo::discover(&tmp.path().join("empty")).unwrap();
    assert!(log::search(&core, None, "anything", 0, 10)
        .unwrap()
        .entries
        .is_empty());
}
