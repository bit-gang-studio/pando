use pando_core::{conflict, operation, sync, Choice, OpKind, Part, Repo, Side};
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

/// main and feat/y both edit a.txt; the rebase of feat/y onto main conflicts.
fn paused() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("work");
    git(&base, &["init", "-q", "-b", "main", "work"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    write(&root, "a.txt", "line\n");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "init"]);
    let wt = base.join("wt");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/y",
            wt.to_str().unwrap(),
        ],
    );
    write(&wt, "a.txt", "theirs\n");
    git(&wt, &["commit", "-q", "-am", "feat edit"]);
    write(&root, "a.txt", "ours\n");
    git(&root, &["commit", "-q", "-am", "main edit"]);
    let repo = Repo::discover(&root).unwrap();
    let r = sync::rebase_onto(&repo, &wt, "feat/y", "main").unwrap();
    assert!(!r.ok);
    (tmp, root, wt)
}

#[test]
fn detect_and_read_sides() {
    let (_t, _root, wt) = paused();
    let op = operation::detect(&wt).unwrap().unwrap();
    assert_eq!(op.kind, OpKind::Rebase);
    assert_eq!((op.applied, op.total), (1, 1));
    assert_eq!(op.conflicted, vec!["a.txt"]);
    assert!(op.head_label.contains("main"), "{}", op.head_label);
    assert!(
        op.incoming_label.contains("feat/y"),
        "{}",
        op.incoming_label
    );

    let f = conflict::file(&wt, "a.txt").unwrap();
    assert_eq!(f.ours, "ours\n");
    assert_eq!(f.theirs, "theirs\n");
    assert_eq!(f.base.as_deref(), Some("line\n"));
    assert!(f.working.contains("<<<<<<<"));
    assert!(!f.binary);
}

#[test]
fn take_both_then_continue() {
    let (_t, root, wt) = paused();
    conflict::take(&wt, "a.txt", Side::Both).unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "ours\ntheirs\n"
    );
    let op = operation::detect(&wt).unwrap().unwrap();
    assert!(op.conflicted.is_empty());
    assert_eq!(op.resolved, vec!["a.txt"]);
    let after = operation::continue_op(&wt).unwrap();
    assert!(after.is_none(), "rebase finished");
    assert_eq!(
        git(&wt, &["log", "--format=%s", "-2"]),
        "feat edit\nmain edit"
    );
    assert_eq!(
        git(&root, &["rev-parse", "main"]),
        git(&wt, &["rev-parse", "HEAD~1"])
    );
}

#[test]
fn take_theirs_resolve_and_reset() {
    let (_t, _root, wt) = paused();
    conflict::take(&wt, "a.txt", Side::Theirs).unwrap();
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "theirs\n"
    );
    conflict::reset(&wt, "a.txt").unwrap();
    assert!(std::fs::read_to_string(wt.join("a.txt"))
        .unwrap()
        .contains("<<<<<<<"));
    assert_eq!(
        operation::detect(&wt).unwrap().unwrap().conflicted,
        vec!["a.txt"]
    );
    conflict::resolve(&wt, "a.txt", "hand merged\n").unwrap();
    assert!(operation::continue_op(&wt).unwrap().is_none());
    assert_eq!(
        std::fs::read_to_string(wt.join("a.txt")).unwrap(),
        "hand merged\n"
    );
}

#[test]
fn continue_refuses_with_conflicts_left() {
    let (_t, _root, wt) = paused();
    assert!(operation::continue_op(&wt).is_err());
    operation::abort(&wt).unwrap();
    assert!(operation::detect(&wt).unwrap().is_none());
}

/// A paused merge of main into feat/m: `many.txt` has three conflicts,
/// `auto.txt` merges cleanly, `gone.txt` is deleted on main and changed on
/// feat/m, `pic.bin` is binary. origin/HEAD exists, to catch bad names.
fn paused_merge() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("work");
    git(&base, &["init", "-q", "--bare", "origin.git"]);
    git(&base, &["init", "-q", "-b", "main", "work"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    let lines = |tag: &str| {
        (1..=30)
            .map(|i| {
                if i % 10 == 5 {
                    format!("{tag} {i}\n")
                } else {
                    format!("line {i}\n")
                }
            })
            .collect::<String>()
    };
    write(&root, "many.txt", &lines("base"));
    write(&root, "auto.txt", "a\nb\nc\nd\ne\nf\ng\n");
    write(&root, "gone.txt", "keep me\n");
    std::fs::write(root.join("pic.bin"), [0u8, 1, 2, 3]).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "init"]);
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
    git(&root, &["remote", "set-head", "origin", "main"]);
    git(&root, &["switch", "-q", "-c", "feat/m"]);
    write(&root, "many.txt", &lines("feat"));
    write(&root, "auto.txt", "a\nb\nc\nd\ne\nf\nFEAT\n");
    write(&root, "gone.txt", "changed on feat\n");
    std::fs::write(root.join("pic.bin"), [0u8, 9, 9]).unwrap();
    git(&root, &["commit", "-q", "-am", "feat"]);
    git(&root, &["switch", "-q", "main"]);
    write(&root, "many.txt", &lines("main"));
    write(&root, "auto.txt", "MAIN\nb\nc\nd\ne\nf\ng\n");
    git(&root, &["rm", "-q", "gone.txt"]);
    std::fs::write(root.join("pic.bin"), [0u8, 7]).unwrap();
    git(&root, &["commit", "-q", "-am", "main"]);
    git(&root, &["push", "-q", "origin", "main"]);
    git(&root, &["switch", "-q", "feat/m"]);
    let out = Command::new("git")
        .current_dir(&root)
        .args(["-c", "user.name=T", "-c", "user.email=t@e", "merge", "main"])
        .output()
        .unwrap();
    assert!(!out.status.success(), "merge should conflict");
    (tmp, root)
}

#[test]
fn a_merge_names_branches_not_origin_head() {
    let (_t, root) = paused_merge();
    let op = operation::detect(&root).unwrap().unwrap();
    assert_eq!(op.kind, OpKind::Merge);
    assert_eq!(op.head_label, "feat/m");
    assert_eq!(op.incoming_label, "main");
    assert_eq!(op.counts["many.txt"], 3);
    assert_eq!(op.counts["gone.txt"], 0);
    assert_eq!(op.resolved, vec!["auto.txt"]);
    assert!(op.resolved_by_you.is_empty(), "auto.txt merged by itself");
}

#[test]
fn merging_a_remote_branch_by_id_still_gets_a_name() {
    let (_t, root) = paused_merge();
    git(&root, &["merge", "--abort"]);
    let id = git(&root, &["rev-parse", "origin/main"]);
    // No branch name in the message: "Merge commit '<id>'" falls back to name-rev.
    let _ = Command::new("git")
        .current_dir(&root)
        .args(["-c", "user.name=T", "-c", "user.email=t@e", "merge", &id])
        .output();
    let op = operation::detect(&root).unwrap().unwrap();
    assert!(
        op.incoming_label == "main"
            || op.incoming_label == "origin/main"
            || op.incoming_label == id,
        "{}",
        op.incoming_label
    );
    assert!(!op.incoming_label.contains("HEAD"), "{}", op.incoming_label);
}

#[test]
fn each_conflict_gets_its_own_choice_in_order() {
    let (_t, root) = paused_merge();
    let f = conflict::file(&root, "many.txt").unwrap();
    let conflicts: Vec<_> = f
        .parts
        .iter()
        .filter(|p| matches!(p, Part::Conflict { .. }))
        .collect();
    assert_eq!(conflicts.len(), 3);
    // Default merge style has no base in the markers; it's borrowed from merge-file.
    for c in &conflicts {
        let Part::Conflict { ours, base, theirs } = c else {
            unreachable!()
        };
        assert!(ours.starts_with("feat "), "{ours}");
        assert!(theirs.starts_with("main "), "{theirs}");
        assert!(base.as_deref().unwrap().starts_with("base "), "{base:?}");
    }
    conflict::choose(
        &root,
        "many.txt",
        &[
            Choice::Both,
            Choice::Theirs,
            Choice::Text {
                text: "mine\n".into(),
            },
        ],
    )
    .unwrap();
    let got = std::fs::read_to_string(root.join("many.txt")).unwrap();
    assert!(
        got.contains("line 4\nfeat 5\nmain 5\nline 6\n"),
        "keep both is ours then theirs:\n{got}"
    );
    assert!(got.contains("line 14\nmain 15\nline 16\n"));
    assert!(got.contains("line 24\nmine\nline 26\n"));
    assert!(!got.contains("<<<<<<<") && !got.contains(">>>>>>>"));
    let op = operation::detect(&root).unwrap().unwrap();
    assert!(!op.conflicted.contains(&"many.txt".to_string()));
    assert_eq!(op.resolved_by_you, vec!["many.txt"]);
    // Back to conflicted brings all three back.
    conflict::reset(&root, "many.txt").unwrap();
    assert_eq!(conflict::count(&root, "many.txt"), 3);
    assert!(operation::detect(&root)
        .unwrap()
        .unwrap()
        .resolved_by_you
        .is_empty());
}

#[test]
fn choose_refuses_when_the_file_changed() {
    let (_t, root) = paused_merge();
    let before = std::fs::read_to_string(root.join("many.txt")).unwrap();
    assert!(
        conflict::choose(&root, "many.txt", &[Choice::Ours]).is_err(),
        "too few choices"
    );
    assert!(
        conflict::choose(&root, "many.txt", &vec![Choice::Ours; 4]).is_err(),
        "too many choices"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("many.txt")).unwrap(),
        before,
        "nothing written"
    );
    assert!(
        conflict::choose(&root, "auto.txt", &[]).is_err(),
        "no conflicts to choose"
    );
}

#[test]
fn diff3_style_gives_the_base_from_the_markers() {
    let (_t, root) = paused_merge();
    git(&root, &["checkout", "--conflict=diff3", "--", "many.txt"]);
    let f = conflict::file(&root, "many.txt").unwrap();
    let Some(Part::Conflict { base, .. }) =
        f.parts.iter().find(|p| matches!(p, Part::Conflict { .. }))
    else {
        panic!()
    };
    assert_eq!(base.as_deref(), Some("base 5\n"));
    conflict::choose(
        &root,
        "many.txt",
        &[Choice::Base, Choice::Ours, Choice::Ours],
    )
    .unwrap();
    assert!(std::fs::read_to_string(root.join("many.txt"))
        .unwrap()
        .contains("line 4\nbase 5\nline 6\n"));
}

#[test]
fn deleted_on_one_side_then_take_the_deleting_side() {
    let (_t, root) = paused_merge();
    let f = conflict::file(&root, "gone.txt").unwrap();
    assert_eq!(f.deleted, Some(Side::Theirs), "main (theirs) deleted it");
    assert!(f.parts.iter().all(|p| matches!(p, Part::Text { .. })));
    conflict::take(&root, "gone.txt", Side::Theirs).unwrap();
    assert!(!root.join("gone.txt").exists());
    let op = operation::detect(&root).unwrap().unwrap();
    assert!(!op.conflicted.contains(&"gone.txt".to_string()));
}

#[test]
fn deleted_on_one_side_then_keep_it() {
    let (_t, root) = paused_merge();
    conflict::take(&root, "gone.txt", Side::Ours).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("gone.txt")).unwrap(),
        "changed on feat\n"
    );
    assert!(!operation::detect(&root)
        .unwrap()
        .unwrap()
        .conflicted
        .contains(&"gone.txt".to_string()));
}

#[test]
fn a_whole_merge_resolved_card_by_card_then_continue() {
    let (_t, root) = paused_merge();
    let f = conflict::file(&root, "pic.bin").unwrap();
    assert!(f.binary && f.parts.is_empty());
    conflict::take(&root, "pic.bin", Side::Theirs).unwrap();
    conflict::take(&root, "gone.txt", Side::Ours).unwrap();
    conflict::choose(
        &root,
        "many.txt",
        &[Choice::Ours, Choice::Ours, Choice::Ours],
    )
    .unwrap();
    let op = operation::detect(&root).unwrap().unwrap();
    assert!(op.conflicted.is_empty());
    let mut by_you = op.resolved_by_you.clone();
    by_you.sort();
    assert_eq!(by_you, vec!["gone.txt", "many.txt", "pic.bin"]);
    assert!(operation::continue_op(&root).unwrap().is_none());
    assert_eq!(std::fs::read(root.join("pic.bin")).unwrap(), vec![0u8, 7]);
    assert_eq!(
        git(&root, &["log", "-1", "--format=%P"]).split(' ').count(),
        2,
        "a merge commit"
    );
}

#[test]
fn keep_original_works_with_gits_default_markers() {
    // The default markers leave the original lines out. "Keep original"
    // used to fail with "no original version" unless diff3 was configured.
    let (_t, root) = paused_merge();
    let marked = std::fs::read_to_string(root.join("many.txt")).unwrap();
    assert!(
        !marked.contains("|||||||"),
        "default style has no base section"
    );
    conflict::choose(
        &root,
        "many.txt",
        &[Choice::Base, Choice::Ours, Choice::Base],
    )
    .unwrap();
    let got = std::fs::read_to_string(root.join("many.txt")).unwrap();
    assert!(got.contains("line 4\nbase 5\nline 6\n"), "{got}");
    assert!(got.contains("line 14\nfeat 15\nline 16\n"));
    assert!(got.contains("line 24\nbase 25\nline 26\n"));
    assert!(!got.contains("<<<<<<<"));
}
