//! Names and refusals: bad branch and tag names never reach git, and the
//! common "no" answers are plain sentences.
mod common;
use common::*;
use pando_core::worktree::CreateWorktree;
use pando_core::{branch, commit, tag, worktree};

const BAD: &[&str] = &[
    "",
    " ",
    "-x",
    "--force",
    "@",
    "HEAD",
    "a..b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "x.lock",
    "/lead",
    "trail/",
    "a//b",
    ".hidden",
    "a/.b",
    "a.",
    "a@{b",
    "tab\tname",
    "new\nline",
];
const GOOD: &[&str] = &[
    "feat/x",
    "ünï/çøde",
    "emoji-🎉",
    "✨",
    "fix/#123",
    "x@y",
    "UPPER/Case",
    "with.dots_and-dashes",
    "HEADS",
    "a/b/c/d/e",
];

fn bad(r: pando_core::Result<impl Sized>, name: &str, kind: &str) {
    let e = r
        .err()
        .unwrap_or_else(|| panic!("{name:?} was accepted"))
        .to_string();
    assert!(
        e.contains(&format!("isn't a valid {kind} name")),
        "{name:?}: {e}"
    );
}

#[test]
fn bad_branch_names_are_refused_everywhere_and_nothing_is_made() {
    let r = repo();
    let core = r.core();
    let wt = add_worktree(&r, "feat/start", "work-start");
    let before = git(&r.root, &["for-each-ref", "refs/heads"]);
    let siblings = || std::fs::read_dir(&r.base).unwrap().count();
    let folders = siblings();
    for name in BAD {
        bad(branch::create(&core, name, None), name, "branch");
        bad(branch::rename(&core, "feat/start", name), name, "branch");
        bad(branch::create_and_switch(&wt, name), name, "branch");
        bad(
            branch::track_remote(&core, "origin/main", name),
            name,
            "branch",
        );
        bad(
            worktree::create(
                &core,
                &CreateWorktree {
                    branch: name.to_string(),
                    base: None,
                    path: None,
                    existing_branch: false,
                },
            ),
            name,
            "branch",
        );
        bad(tag::create(&core, name, "main", None), name, "tag");
    }
    assert_eq!(git(&r.root, &["for-each-ref", "refs/heads"]), before);
    assert_eq!(git(&r.root, &["tag"]), "");
    assert_eq!(siblings(), folders, "no stray worktree folders");
}

#[test]
fn odd_but_valid_names_work_and_get_a_usable_folder() {
    let r = repo();
    let core = r.core();
    for name in GOOD {
        let made = worktree::create(
            &core,
            &CreateWorktree {
                branch: name.to_string(),
                base: None,
                path: None,
                existing_branch: false,
            },
        )
        .unwrap_or_else(|e| panic!("{name}: {e}"));
        let folder = made
            .worktree
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            folder.starts_with("work-") && folder.len() > "work-".len(),
            "{name}: folder {folder:?}"
        );
        assert_eq!(made.worktree.branch.as_deref(), Some(*name));
        tag::create(&core, &format!("t/{name}"), "main", None)
            .unwrap_or_else(|e| panic!("tag {name}: {e}"));
    }
    // A name with no letters or digits still gets a real folder name.
    assert!(r.base.join("work-worktree").is_dir());
}

#[test]
fn remove_and_move_say_no_plainly_and_touch_nothing() {
    let r = repo();
    let core = r.core();
    let wt = add_worktree(&r, "feat/x", "work-feat-x");
    write(&wt, "wip.txt", "precious\n");
    let e = |r: pando_core::Result<()>| r.unwrap_err().to_string();
    // The main worktree.
    assert_eq!(
        e(worktree::remove(&core, &r.root, true).map(|_| ())),
        "The main worktree can't be removed."
    );
    assert_eq!(
        e(worktree::move_to(&core, &r.root, &r.base.join("elsewhere"))),
        "The main worktree can't be moved."
    );
    // A plain folder, and a folder that is a different repository.
    let plain = r.base.join("plain");
    std::fs::create_dir(&plain).unwrap();
    assert!(e(worktree::remove(&core, &plain, true).map(|_| ()))
        .contains("isn't a worktree of this repository"));
    let other = repo_named("other");
    write(&other.root, "theirs.txt", "not ours\n");
    let objects = git(&other.root, &["count-objects"]);
    assert!(e(worktree::remove(&core, &other.root, true).map(|_| ()))
        .contains("isn't a worktree of this repository"));
    assert_eq!(
        git(&other.root, &["count-objects"]),
        objects,
        "nothing written into someone else's repo"
    );
    assert_eq!(read(&other.root, "theirs.txt"), "not ours\n");
    // A locked worktree, with and without a reason.
    worktree::lock(&core, &wt, Some("on a usb stick")).unwrap();
    assert_eq!(
        e(worktree::remove(&core, &wt, true).map(|_| ())),
        "This worktree is locked (on a usb stick). Unlock it first."
    );
    assert_eq!(
        e(worktree::move_to(&core, &wt, &r.base.join("moved"))),
        "This worktree is locked (on a usb stick). Unlock it first."
    );
    worktree::unlock(&core, &wt).unwrap();
    worktree::lock(&core, &wt, None).unwrap();
    assert_eq!(
        e(worktree::remove(&core, &wt, false).map(|_| ())),
        "This worktree is locked. Unlock it first."
    );
    assert_eq!(read(&wt, "wip.txt"), "precious\n");
    assert!(
        pando_refs(&r).iter().all(|x| !x.contains("snapshots")),
        "no snapshot for a refused removal"
    );
    // Unlocked, it goes as before.
    worktree::unlock(&core, &wt).unwrap();
    worktree::remove(&core, &wt, true).unwrap();
}

#[test]
fn cherry_picking_or_reverting_a_merge_is_refused_in_plain_words() {
    let r = repo();
    git(&r.root, &["switch", "-q", "-c", "side"]);
    commit(&r.root, "side.txt", "s\n");
    git(&r.root, &["switch", "-q", "main"]);
    commit(&r.root, "main.txt", "m\n");
    git(
        &r.root,
        &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
    );
    let merge = r.tip("HEAD");
    let core = r.core();
    let pick = commit::cherry_pick(&core, &r.root, &merge)
        .unwrap_err()
        .to_string();
    assert_eq!(
        pick,
        format!(
            "{} is a merge commit. Pando can't cherry-pick a merge.",
            &merge[..7]
        )
    );
    let rev = commit::revert(&core, &r.root, &merge)
        .unwrap_err()
        .to_string();
    assert!(rev.ends_with("Pando can't revert a merge."), "{rev}");
    assert_eq!(r.tip("HEAD"), merge);
    assert_eq!(git(&r.root, &["status", "--porcelain"]), "");
    assert!(pando_refs(&r).is_empty(), "no backup written for a refusal");
    // A plain commit still picks.
    let plain = r.tip("side");
    git(&r.root, &["switch", "-q", "-c", "target", "HEAD~2"]);
    commit::cherry_pick(&core, &r.root, &plain).unwrap();
}
