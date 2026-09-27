//! Odd names, odd paths, odd repos.
mod common;
use common::*;
use pando_core::{
    branch, detail, diff, history, index, log, overview, stash, status, worktree, CreateWorktree,
    Repo as CoreRepo,
};

#[test]
fn a_repo_folder_with_spaces_and_unicode() {
    let r = repo_named("my répo ü");
    let core = r.core();
    let o = overview::load(&core).unwrap();
    assert_eq!(o.branches.len(), 1);
    let made = worktree::create(
        &core,
        &CreateWorktree {
            branch: "feat/ünï côde".replace(' ', "-"),
            base: None,
            path: None,
            existing_branch: false,
        },
    )
    .unwrap();
    assert!(made.worktree.path.exists());
    assert!(made
        .worktree
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("my répo ü-"));
    let o = overview::load(&core).unwrap();
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/ünï-côde")
        .unwrap();
    assert_eq!(row.worktree.as_ref().unwrap().path, made.worktree.path);
    worktree::remove(&core, &made.worktree.path, false).unwrap();
}

#[test]
fn branches_that_slug_the_same_get_distinct_folders() {
    let r = repo();
    let core = r.core();
    let make = |b: &str| {
        worktree::create(
            &core,
            &CreateWorktree {
                branch: b.into(),
                base: None,
                path: None,
                existing_branch: false,
            },
        )
        .unwrap()
        .worktree
        .path
    };
    let a = make("a/b-c");
    let b = make("a-b/c");
    assert_ne!(a, b);
    assert!(a.exists() && b.exists());
}

#[test]
fn file_names_git_must_quote() {
    let r = repo();
    let mut names = vec![
        "with space.txt",
        "ünïcode.txt",
        "quote\"d.txt",
        "back\\slash.txt",
        "日本.txt",
    ];
    if cfg!(windows) {
        names.retain(|n| !n.contains('"') && !n.contains('\\'));
    } else {
        names.push("new\nline.txt");
        names.push("tab\there.txt");
    }
    for n in &names {
        write(&r.root, n, "x\n");
    }
    let files = status::files(&r.root).unwrap();
    let got: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
    for n in &names {
        assert!(got.contains(n), "missing {n:?} in {got:?}");
    }
    assert_eq!(
        status::summary(&r.root).unwrap().untracked as usize,
        names.len()
    );

    // Stage, diff and discard each one by the name status gave us.
    let paths: Vec<String> = names.iter().map(|n| n.to_string()).collect();
    index::stage(&r.root, &paths).unwrap();
    assert_eq!(
        status::summary(&r.root).unwrap().staged as usize,
        names.len()
    );
    for n in &names {
        let d = diff::file(&r.root, n, true, false).unwrap();
        assert_eq!(d.added, 1, "{n:?}");
    }
    index::unstage_all(&r.root).unwrap();
    index::discard(&r.root, &[], &paths).unwrap();
    assert_eq!(status::summary(&r.root).unwrap().untracked, 0);
}

#[test]
fn stage_one_hunk_of_two() {
    let r = repo();
    let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    commit(&r.root, "f.txt", &body);
    let edited = body
        .replace("line 2\n", "line 2 edited\n")
        .replace("line 29\n", "line 29 edited\n");
    write(&r.root, "f.txt", &edited);
    let d = diff::file(&r.root, "f.txt", false, false).unwrap();
    assert_eq!(d.hunks.len(), 2);
    index::apply_hunk(&r.root, "f.txt", &d.hunks[1], false).unwrap();
    let staged = git(&r.root, &["diff", "--cached"]);
    assert!(
        staged.contains("line 29 edited") && !staged.contains("line 2 edited"),
        "{staged}"
    );
    // And back out again.
    let d = diff::file(&r.root, "f.txt", true, false).unwrap();
    index::apply_hunk(&r.root, "f.txt", &d.hunks[0], true).unwrap();
    assert_eq!(git(&r.root, &["diff", "--cached"]), "");
    assert_eq!(read(&r.root, "f.txt"), edited, "working copy never touched");
}

#[test]
fn a_file_without_a_trailing_newline() {
    let r = repo();
    commit(&r.root, "n.txt", "a\nb");
    write(&r.root, "n.txt", "a\nc");
    let d = diff::file(&r.root, "n.txt", false, false).unwrap();
    assert!(d.hunks[0].lines.iter().any(|l| l.no_newline));
    index::apply_hunk(&r.root, "n.txt", &d.hunks[0], false).unwrap();
    assert_eq!(git(&r.root, &["show", ":n.txt"]), "a\nc");
}

#[test]
fn binary_files_are_marked_not_parsed() {
    let r = repo();
    std::fs::write(r.root.join("b.bin"), [0u8, 1, 2, 255, 0, 7]).unwrap();
    let d = diff::file(&r.root, "b.bin", false, true).unwrap();
    assert!(d.binary);
    assert!(d.hunks.is_empty());
}

#[test]
fn an_empty_repo_with_no_commits() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    write(&root, "a.txt", "a\n");
    let core = CoreRepo::discover(&root).unwrap();
    let o = overview::load(&core).unwrap();
    assert!(o.branches.is_empty() || o.branches[0].branch.name == "main");
    let l = log::list(&core, None, 0, 50).unwrap();
    assert!(l.entries.is_empty());
    assert!(stash::list(&core).unwrap().is_empty());
    assert_eq!(status::summary(&root).unwrap().untracked, 1);
    detail::load(&core, &root).unwrap();
}

#[test]
fn not_a_repo_is_a_clear_error() {
    let tmp = tempfile::tempdir().unwrap();
    let err = CoreRepo::discover(tmp.path()).unwrap_err().to_string();
    assert!(err.contains("not a git repository"), "{err}");
}

#[test]
fn a_bare_repo_has_no_worktree_rows() {
    let r = repo();
    let core = CoreRepo::discover(&r.origin).unwrap();
    assert!(core.bare);
    let o = overview::load(&core).unwrap();
    assert!(o.branches.iter().all(|b| b.worktree.is_none()));
    assert!(o.detached.is_empty());
}

#[test]
fn a_detached_main_worktree_shows_as_detached() {
    let r = repo();
    git(&r.root, &["switch", "-q", "--detach"]);
    let o = overview::load(&r.core()).unwrap();
    assert_eq!(o.detached.len(), 1);
    assert!(o.detached[0].is_main_worktree);
    branch::create_and_switch(&r.root, "rescued").unwrap();
    assert_eq!(git(&r.root, &["branch", "--show-current"]), "rescued");
    assert!(overview::load(&r.core()).unwrap().detached.is_empty());
}

#[test]
fn a_worktree_whose_folder_was_deleted() {
    let r = repo();
    let wt = add_worktree(&r, "feat/x", "wt");
    std::fs::remove_dir_all(&wt).unwrap();
    let o = overview::load(&r.core()).unwrap();
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/x")
        .unwrap();
    assert!(row.worktree.as_ref().unwrap().prunable.is_some());
    assert!(row.status.is_none());
    worktree::prune(&r.core()).unwrap();
    let o = overview::load(&r.core()).unwrap();
    let row = o
        .branches
        .iter()
        .find(|b| b.branch.name == "feat/x")
        .unwrap();
    assert!(row.worktree.is_none(), "pruned, branch kept");
}

#[test]
fn log_pages_past_the_end_and_by_branch() {
    let r = repo();
    for i in 0..5 {
        commit(&r.root, "f.txt", &format!("{i}\n"));
    }
    let core = r.core();
    let all = log::list(&core, None, 0, 100).unwrap();
    assert_eq!(all.entries.len(), 6);
    assert!(!all.truncated);
    let page = log::list(&core, None, 0, 4).unwrap();
    assert_eq!(page.entries.len(), 4);
    assert!(page.truncated);
    assert!(log::list(&core, None, 50, 10).unwrap().entries.is_empty());
    assert!(log::list(&core, Some("no-such-branch"), 0, 10).is_err());
}

#[test]
fn history_of_the_first_commit_and_of_a_merge() {
    let r = repo();
    let first = git(&r.root, &["rev-list", "--max-parents=0", "HEAD"]);
    let d = history::commit_diff(&r.core(), &first).unwrap();
    assert_eq!(d.files.len(), 1);
    history::commit_file_diff(&r.core(), &first, "README.md").unwrap();

    git(&r.root, &["switch", "-q", "-c", "side"]);
    commit(&r.root, "side.txt", "s\n");
    git(&r.root, &["switch", "-q", "main"]);
    commit(&r.root, "m.txt", "m\n");
    git(
        &r.root,
        &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
    );
    let d = history::commit_diff(&r.core(), "HEAD").unwrap();
    let names: Vec<_> = d.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(names, ["side.txt"], "merge shows what it brought in");
}

#[test]
fn renamed_files_show_once() {
    let r = repo();
    git(&r.root, &["mv", "README.md", "READ ME.md"]);
    let files = status::files(&r.root).unwrap();
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].path, "READ ME.md");
}
