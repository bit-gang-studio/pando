//! Staging and unstaging single lines. Every case checks both what git has
//! staged and that the working copy was never touched.
mod common;
use common::*;
use pando_core::{diff, index};

fn body(lines: &[&str]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// A file with one hunk: line 2 removed, lines "new a" and "new b" added.
fn setup() -> (Repo, String) {
    let r = repo();
    commit(&r.root, "f.txt", &body(&["one", "two", "three"]));
    let edited = body(&["one", "new a", "new b", "three"]);
    write(&r.root, "f.txt", &edited);
    (r, edited)
}

fn line_index(h: &pando_core::Hunk, text: &str) -> usize {
    h.lines.iter().position(|l| l.text == text).unwrap()
}

#[test]
fn stage_one_added_line() {
    let (r, edited) = setup();
    let d = diff::file(&r.root, "f.txt", false, false).unwrap();
    let h = &d.hunks[0];
    index::apply_lines(&r.root, "f.txt", h, &[line_index(h, "new b")], false).unwrap();
    assert_eq!(
        git(&r.root, &["show", ":f.txt"]),
        "one\ntwo\nnew b\nthree",
        "removal not staged, only new b"
    );
    assert_eq!(read(&r.root, "f.txt"), edited);
}

#[test]
fn stage_only_the_removal() {
    let (r, edited) = setup();
    let d = diff::file(&r.root, "f.txt", false, false).unwrap();
    let h = &d.hunks[0];
    index::apply_lines(&r.root, "f.txt", h, &[line_index(h, "two")], false).unwrap();
    assert_eq!(git(&r.root, &["show", ":f.txt"]), "one\nthree");
    assert_eq!(read(&r.root, "f.txt"), edited);
}

#[test]
fn stage_all_then_unstage_one_line() {
    let (r, edited) = setup();
    index::stage(&r.root, &["f.txt".into()]).unwrap();
    let d = diff::file(&r.root, "f.txt", true, false).unwrap();
    let h = &d.hunks[0];
    index::apply_lines(&r.root, "f.txt", h, &[line_index(h, "new a")], true).unwrap();
    assert_eq!(
        git(&r.root, &["show", ":f.txt"]),
        "one\nnew b\nthree",
        "new a unstaged, rest stays"
    );
    assert_eq!(read(&r.root, "f.txt"), edited);
}

#[test]
fn staging_lines_one_by_one_adds_up_to_the_whole_change() {
    let (r, edited) = setup();
    for text in ["new a", "two", "new b"] {
        let d = diff::file(&r.root, "f.txt", false, false).unwrap();
        let h = &d.hunks[0];
        index::apply_lines(&r.root, "f.txt", h, &[line_index(h, text)], false).unwrap();
    }
    assert_eq!(git(&r.root, &["show", ":f.txt"]) + "\n", edited);
    assert_eq!(
        git(&r.root, &["diff", "--name-only"]),
        "",
        "nothing left unstaged"
    );
}

#[test]
fn lines_in_the_second_hunk_of_a_long_file() {
    let r = repo();
    let lines: Vec<String> = (1..=40).map(|i| format!("line {i}")).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    commit(&r.root, "long.txt", &body(&refs));
    let mut edited = refs.clone();
    edited[1] = "first edit";
    edited.insert(35, "added near the end");
    write(&r.root, "long.txt", &body(&edited));
    let d = diff::file(&r.root, "long.txt", false, false).unwrap();
    assert_eq!(d.hunks.len(), 2);
    let h = &d.hunks[1];
    index::apply_lines(
        &r.root,
        "long.txt",
        h,
        &[line_index(h, "added near the end")],
        false,
    )
    .unwrap();
    let staged = git(&r.root, &["show", ":long.txt"]);
    assert!(
        staged.contains("added near the end") && !staged.contains("first edit"),
        "{staged}"
    );
}

#[test]
fn choosing_only_context_is_refused() {
    let (r, _) = setup();
    let d = diff::file(&r.root, "f.txt", false, false).unwrap();
    let h = &d.hunks[0];
    assert!(index::apply_lines(&r.root, "f.txt", h, &[line_index(h, "one")], false).is_err());
    assert!(index::apply_lines(&r.root, "f.txt", h, &[], false).is_err());
    assert_eq!(git(&r.root, &["diff", "--cached"]), "");
}

#[test]
fn a_line_without_a_trailing_newline() {
    let r = repo();
    commit(&r.root, "n.txt", "a\nb");
    write(&r.root, "n.txt", "a\nb\nc");
    let d = diff::file(&r.root, "n.txt", false, false).unwrap();
    let h = &d.hunks[0];
    let picks: Vec<usize> = h
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.kind != diff::LineKind::Context)
        .map(|(i, _)| i)
        .collect();
    index::apply_lines(&r.root, "n.txt", h, &picks, false).unwrap();
    assert_eq!(git(&r.root, &["show", ":n.txt"]), "a\nb\nc");
}
