use pando_core::{commit, detail, diff, index, status, sync, Repo};
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

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

fn fixture() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("work");
    git(&base, &["init", "-q", "-b", "main", "work"]);
    // CI runners have no global identity; core commands must find one.
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    write(
        &root,
        "a.txt",
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "init"]);
    Fx { _tmp: tmp, root }
}

#[test]
fn status_files_and_diffs() {
    let f = fixture();
    write(
        &f.root,
        "a.txt",
        "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
    );
    write(&f.root, "new.txt", "hello\n");
    let files = status::files(&f.root).unwrap();
    assert_eq!(files.len(), 2);
    let a = &files[0];
    assert_eq!((a.path.as_str(), a.unstaged), ("a.txt", Some('M')));
    assert!(files[1].untracked);

    let d = diff::file(&f.root, "a.txt", false, false).unwrap();
    assert_eq!(d.hunks.len(), 2, "two separate hunks with -U3 on 10 lines");
    assert_eq!((d.added, d.deleted), (2, 2));
    let n = diff::file(&f.root, "new.txt", false, true).unwrap();
    assert!(n.new_file);
    assert_eq!(n.hunks[0].lines[0].text, "hello");
}

#[test]
fn stage_one_hunk_then_unstage_it() {
    let f = fixture();
    write(
        &f.root,
        "a.txt",
        "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
    );
    let d = diff::file(&f.root, "a.txt", false, false).unwrap();
    index::apply_hunk(&f.root, "a.txt", &d.hunks[0], false).unwrap();
    let staged = diff::file(&f.root, "a.txt", true, false).unwrap();
    assert_eq!(staged.hunks.len(), 1);
    assert!(staged.hunks[0].lines.iter().any(|l| l.text == "ONE"));
    let unstaged = diff::file(&f.root, "a.txt", false, false).unwrap();
    assert_eq!(unstaged.hunks.len(), 1);
    assert!(unstaged.hunks[0].lines.iter().any(|l| l.text == "TEN"));

    index::apply_hunk(&f.root, "a.txt", &staged.hunks[0], true).unwrap();
    assert!(diff::file(&f.root, "a.txt", true, false)
        .unwrap()
        .hunks
        .is_empty());
}

#[test]
fn stage_commit_discard() {
    let f = fixture();
    write(&f.root, "a.txt", "changed\n");
    write(&f.root, "new.txt", "hello\n");
    index::stage(&f.root, &["new.txt".into()]).unwrap();
    let files = status::files(&f.root).unwrap();
    assert_eq!(
        files.iter().find(|x| x.path == "new.txt").unwrap().staged,
        Some('A')
    );
    let id = commit::create(&f.root, "add new", false).unwrap();
    assert_eq!(id.len(), 40);
    assert_eq!(git(&f.root, &["log", "-1", "--format=%s"]), "add new");

    index::discard(&f.root, &["a.txt".into()], &[]).unwrap();
    assert!(status::files(&f.root).unwrap().is_empty());
    write(&f.root, "junk.txt", "x");
    index::discard(&f.root, &[], &["junk.txt".into()]).unwrap();
    assert!(!f.root.join("junk.txt").exists());
}

#[test]
fn detail_and_sync() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let wt = f.root.parent().unwrap().join("wt");
    git(
        &f.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/x",
            wt.to_str().unwrap(),
        ],
    );
    write(&wt, "b.txt", "b\n");
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-q", "-m", "feat commit"]);
    write(&f.root, "c.txt", "c\n");
    git(&f.root, &["add", "."]);
    git(&f.root, &["commit", "-q", "-m", "main moved"]);
    write(&wt, "b.txt", "b2\n");

    let d = detail::load(&repo, &wt).unwrap();
    assert_eq!(d.worktree.branch.as_deref(), Some("feat/x"));
    assert_eq!(d.ahead.len(), 1);
    assert_eq!(d.ahead[0].summary, "feat commit");
    assert_eq!(d.base_branch.as_deref(), Some("main"));
    assert_eq!(d.files.len(), 1);

    git(&wt, &["stash", "-q"]);
    let r = sync::rebase_onto(&repo, &wt, "feat/x", "main").unwrap();
    assert!(r.ok, "{}", r.message);
    assert!(wt.join("c.txt").exists());
    assert_eq!(
        git(
            &f.root,
            &["rev-parse", "--verify", "refs/pando/backup/feat/x"]
        )
        .len(),
        40
    );
}

#[test]
fn sync_conflict_pauses_and_can_abort() {
    let f = fixture();
    let repo = Repo::discover(&f.root).unwrap();
    let wt = f.root.parent().unwrap().join("wt");
    git(
        &f.root,
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
    write(&f.root, "a.txt", "ours\n");
    git(&f.root, &["commit", "-q", "-am", "main edit"]);
    let r = sync::rebase_onto(&repo, &wt, "feat/y", "main").unwrap();
    assert!(!r.ok);
    assert_eq!(r.conflicts, vec!["a.txt"]);
    let op = pando_core::operation::detect(&wt).unwrap().expect("paused");
    assert_eq!(op.kind, pando_core::OpKind::Rebase);
    assert_eq!(op.conflicted, vec!["a.txt"]);
    pando_core::operation::abort(&wt).unwrap();
    assert!(pando_core::operation::detect(&wt).unwrap().is_none());
    assert_eq!(git(&wt, &["log", "-1", "--format=%s"]), "feat edit");
    assert!(
        status::files(&wt).unwrap().is_empty(),
        "abort restored a clean tree"
    );
}
