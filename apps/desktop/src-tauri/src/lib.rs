//! Thin Tauri shell. All logic is in pando-core.

mod terminal;

#[cfg(debug_assertions)]
#[doc(hidden)]
pub mod dev_bridge;

use pando_core::{
    backup, branch, commit, conflict, detail, diff, github, history, index, log, merge, operation,
    overview, stash, sync, tag, user_config, watch, worktree, Applied, Backup, CommitDiff,
    ConflictFile, CreateWorktree, Created, Detail, FileDiff, Hunk, Log, MergePlan, MergeResult,
    Operation, Overview, Preflight, Repo, Side, Stash, SyncResult, UserConfig,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Emitter;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Run a blocking core call off the main thread so the window stays responsive.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

fn repo(root: &std::path::Path) -> R<Repo> {
    Repo::discover(root).map_err(err)
}

// ---- access ----------------------------------------------------------------

/// Folders the OS won't let Pando read (macOS privacy). The app runs this
/// before any git, so the user sees one prompt, not one per git command.
#[tauri::command]
async fn access_check(paths: Vec<PathBuf>) -> R<Vec<PathBuf>> {
    blocking(move || Ok(pando_core::access::check(&paths))).await
}

// ---- repos ---------------------------------------------------------------

#[tauri::command]
async fn repos_list() -> R<UserConfig> {
    blocking(|| user_config::load().map_err(err)).await
}

#[tauri::command]
async fn repos_add(path: PathBuf) -> R<UserConfig> {
    blocking(move || {
        let r = repo(&path)?;
        user_config::add_repo(&r.root).map_err(err)
    })
    .await
}

#[tauri::command]
async fn repos_remove(path: PathBuf) -> R<UserConfig> {
    blocking(move || user_config::remove_repo(&path).map_err(err)).await
}

// ---- the list --------------------------------------------------------------

#[tauri::command]
async fn overview_load(root: PathBuf, quick: Option<bool>) -> R<Overview> {
    blocking(move || {
        let r = repo(&root)?;
        if quick == Some(true) {
            overview::load_quick(&r)
        } else {
            overview::load(&r)
        }
        .map_err(err)
    })
    .await
}

#[tauri::command]
async fn fetch_all(root: PathBuf) -> R<()> {
    blocking(move || branch::fetch_all(&repo(&root)?).map_err(err)).await
}

/// `git branch <name> [<base>]`, without a worktree.
#[tauri::command]
async fn branch_create(root: PathBuf, name: String, base: Option<String>) -> R<()> {
    blocking(move || branch::create(&repo(&root)?, &name, base.as_deref()).map_err(err)).await
}

/// `git push -u origin <branch>`.
#[tauri::command]
async fn branch_push(root: PathBuf, name: String) -> R<()> {
    blocking(move || branch::push(&repo(&root)?, &name, "origin", false).map_err(err)).await
}

/// `git pull --rebase` in a worktree.
#[tauri::command]
async fn branch_pull(worktree: PathBuf) -> R<()> {
    blocking(move || branch::pull(&worktree, true).map_err(err)).await
}

/// `git branch -D`, after a backup ref. Optionally also deletes it on origin.
#[tauri::command]
async fn branch_delete(root: PathBuf, name: String, remote: bool) -> R<()> {
    blocking(move || {
        let r = repo(&root)?;
        branch::delete(&r, &name, true).map_err(err)?;
        if remote {
            branch::delete_remote(&r, "origin", &name).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn worktree_path_preview(root: PathBuf, branch: String) -> R<String> {
    blocking(move || {
        Ok(worktree::default_path(&repo(&root)?, &branch)
            .to_string_lossy()
            .into_owned())
    })
    .await
}

#[tauri::command]
async fn worktree_add(root: PathBuf, req: CreateWorktree) -> R<Created> {
    blocking(move || worktree::create(&repo(&root)?, &req).map_err(err)).await
}

#[tauri::command]
async fn worktree_remove(root: PathBuf, path: PathBuf, force: bool) -> R<worktree::Removed> {
    blocking(move || worktree::remove(&repo(&root)?, &path, force).map_err(err)).await
}

/// The terminal "Open in …" will use, or None if there isn't one.
#[tauri::command]
fn terminal_name() -> Option<String> {
    terminal::name()
}

#[tauri::command]
fn open_terminal(path: PathBuf) -> R<()> {
    terminal::open(&path)
}

/// Undo Remove worktree: add it back in the same folder, with any saved changes.
#[tauri::command]
async fn worktree_undo_remove(root: PathBuf, removed: worktree::Removed) -> R<()> {
    blocking(move || worktree::undo_remove(&repo(&root)?, &removed).map_err(err)).await
}

// ---- worktree actions --------------------------------------------------------

#[tauri::command]
async fn worktree_move(root: PathBuf, from: PathBuf, to: PathBuf) -> R<()> {
    blocking(move || worktree::move_to(&repo(&root)?, &from, &to).map_err(err)).await
}

#[tauri::command]
async fn worktree_lock(root: PathBuf, path: PathBuf, locked: bool) -> R<()> {
    blocking(move || {
        let r = repo(&root)?;
        if locked {
            worktree::lock(&r, &path, None)
        } else {
            worktree::unlock(&r, &path)
        }
        .map_err(err)
    })
    .await
}

#[tauri::command]
async fn worktree_prune(root: PathBuf) -> R<u32> {
    blocking(move || worktree::prune(&repo(&root)?).map_err(err)).await
}

// ---- branch actions ----------------------------------------------------------

/// Check out another branch in the main worktree (`git switch`).
#[tauri::command]
async fn branch_switch(root: PathBuf, name: String) -> R<()> {
    blocking(move || branch::switch_in_main(&repo(&root)?, &name).map_err(err)).await
}

/// `git switch -c <name>` in a worktree, e.g. to leave a detached HEAD.
#[tauri::command]
async fn branch_create_and_switch(path: PathBuf, name: String) -> R<()> {
    blocking(move || branch::create_and_switch(&path, &name).map_err(err)).await
}

#[tauri::command]
async fn branch_rename(root: PathBuf, old: String, new: String) -> R<()> {
    blocking(move || branch::rename(&repo(&root)?, &old, &new).map_err(err)).await
}

#[tauri::command]
async fn branch_set_upstream(root: PathBuf, name: String, upstream: String) -> R<()> {
    blocking(move || branch::set_upstream(&repo(&root)?, &name, &upstream).map_err(err)).await
}

/// Delete a branch on origin only.
#[tauri::command]
async fn branch_delete_remote(root: PathBuf, name: String) -> R<()> {
    blocking(move || branch::delete_remote(&repo(&root)?, "origin", &name).map_err(err)).await
}

// ---- commit actions ----------------------------------------------------------

#[tauri::command]
async fn commit_cherry_pick(root: PathBuf, worktree: PathBuf, id: String) -> R<Applied> {
    blocking(move || commit::cherry_pick(&repo(&root)?, &worktree, &id).map_err(err)).await
}

#[tauri::command]
async fn commit_revert(root: PathBuf, worktree: PathBuf, id: String) -> R<Applied> {
    blocking(move || commit::revert(&repo(&root)?, &worktree, &id).map_err(err)).await
}

#[tauri::command]
async fn tag_delete(root: PathBuf, name: String) -> R<()> {
    blocking(move || tag::delete(&repo(&root)?, &name).map_err(err)).await
}

#[tauri::command]
async fn tag_push(root: PathBuf, name: String) -> R<()> {
    blocking(move || tag::push(&repo(&root)?, &name).map_err(err)).await
}

// ---- clone -------------------------------------------------------------------------

/// Your GitHub repos and your organisations' (via gh). None without gh.
#[tauri::command]
async fn remote_repos() -> R<Option<Vec<github::RemoteRepo>>> {
    blocking(|| github::repos().map_err(err)).await
}

/// Clone into `<parent>/<name>` and add it to the list.
#[tauri::command]
async fn repo_clone(source: String, parent: PathBuf) -> R<UserConfig> {
    blocking(move || {
        let dest = github::clone(&source, &parent).map_err(err)?;
        user_config::add_repo(&dest).map_err(err)
    })
    .await
}

// ---- pull requests -------------------------------------------------------------

#[tauri::command]
async fn prs_list(root: PathBuf) -> R<github::PullRequests> {
    blocking(move || github::list(&repo(&root)?).map_err(err)).await
}

#[tauri::command]
async fn pr_add_worktree(root: PathBuf, pr: github::PullRequest) -> R<Created> {
    blocking(move || github::add_worktree(&repo(&root)?, &pr).map_err(err)).await
}

// ---- backups -------------------------------------------------------------------

#[tauri::command]
async fn backups_list(root: PathBuf) -> R<Vec<Backup>> {
    blocking(move || backup::list(&repo(&root)?).map_err(err)).await
}

#[tauri::command]
async fn backup_restore_branch(root: PathBuf, refname: String) -> R<()> {
    blocking(move || backup::restore_branch(&repo(&root)?, &refname).map_err(err)).await
}

#[tauri::command]
async fn backup_restore_files(root: PathBuf, refname: String, worktree: PathBuf) -> R<()> {
    blocking(move || backup::restore_files(&repo(&root)?, &refname, &worktree).map_err(err)).await
}

#[tauri::command]
async fn backup_delete(root: PathBuf, refname: String) -> R<()> {
    blocking(move || backup::delete(&repo(&root)?, &refname).map_err(err)).await
}

#[tauri::command]
async fn tag_create(
    root: PathBuf,
    name: String,
    target: String,
    message: Option<String>,
    push: bool,
) -> R<()> {
    blocking(move || {
        let r = repo(&root)?;
        tag::create(&r, &name, &target, message.as_deref()).map_err(err)?;
        if push {
            tag::push(&r, &name).map_err(err)?;
        }
        Ok(())
    })
    .await
}

// ---- stash -------------------------------------------------------------------

#[tauri::command]
async fn stash_list(root: PathBuf) -> R<Vec<Stash>> {
    blocking(move || stash::list(&repo(&root)?).map_err(err)).await
}

#[tauri::command]
async fn stash_save(worktree: PathBuf, message: Option<String>) -> R<bool> {
    blocking(move || stash::save(&worktree, message.as_deref()).map_err(err)).await
}

#[tauri::command]
async fn stash_apply(worktree: PathBuf, index: u32, pop: bool) -> R<()> {
    blocking(move || {
        if pop {
            stash::pop(&worktree, index)
        } else {
            stash::apply(&worktree, index)
        }
        .map_err(err)
    })
    .await
}

/// Undo Drop stash: back into the stash list.
#[tauri::command]
async fn stash_restore(root: PathBuf, kept: String, message: String) -> R<()> {
    blocking(move || stash::restore(&repo(&root)?, &kept, &message).map_err(err)).await
}

#[tauri::command]
async fn stash_drop(root: PathBuf, index: u32) -> R<String> {
    blocking(move || stash::drop(&repo(&root)?, index).map_err(err)).await
}

// ---- log -------------------------------------------------------------------

#[tauri::command]
async fn log_list(root: PathBuf, branch: Option<String>, skip: usize, limit: usize) -> R<Log> {
    blocking(move || log::list(&repo(&root)?, branch.as_deref(), skip, limit).map_err(err)).await
}

#[tauri::command]
async fn commit_diff(root: PathBuf, id: String) -> R<CommitDiff> {
    blocking(move || history::commit_diff(&repo(&root)?, &id).map_err(err)).await
}

#[tauri::command]
async fn compare(root: PathBuf, base: String, head: String) -> R<history::Compare> {
    blocking(move || history::compare(&repo(&root)?, &base, &head).map_err(err)).await
}

#[tauri::command]
async fn compare_file_diff(root: PathBuf, base: String, head: String, path: String) -> R<FileDiff> {
    blocking(move || history::compare_file_diff(&repo(&root)?, &base, &head, &path).map_err(err))
        .await
}

#[tauri::command]
async fn commit_file_diff(root: PathBuf, id: String, path: String) -> R<FileDiff> {
    blocking(move || history::commit_file_diff(&repo(&root)?, &id, &path).map_err(err)).await
}

// ---- detail: changes and commits -------------------------------------------

#[tauri::command]
async fn detail_load(root: PathBuf, path: PathBuf) -> R<Detail> {
    blocking(move || detail::load(&repo(&root)?, &path).map_err(err)).await
}

#[tauri::command]
async fn diff_file(worktree: PathBuf, path: String, staged: bool, untracked: bool) -> R<FileDiff> {
    blocking(move || diff::file(&worktree, &path, staged, untracked).map_err(err)).await
}

#[tauri::command]
async fn stage_paths(worktree: PathBuf, paths: Vec<String>) -> R<()> {
    blocking(move || index::stage(&worktree, &paths).map_err(err)).await
}

#[tauri::command]
async fn unstage_paths(worktree: PathBuf, paths: Vec<String>) -> R<()> {
    blocking(move || index::unstage(&worktree, &paths).map_err(err)).await
}

#[tauri::command]
async fn stage_all(worktree: PathBuf) -> R<()> {
    blocking(move || index::stage_all(&worktree).map_err(err)).await
}

#[tauri::command]
async fn unstage_all(worktree: PathBuf) -> R<()> {
    blocking(move || index::unstage_all(&worktree).map_err(err)).await
}

#[tauri::command]
async fn discard_paths(
    worktree: PathBuf,
    paths: Vec<String>,
    untracked: Vec<String>,
) -> R<Option<String>> {
    blocking(move || index::discard(&worktree, &paths, &untracked).map_err(err)).await
}

#[tauri::command]
async fn apply_hunk(worktree: PathBuf, path: String, hunk: Hunk, reverse: bool) -> R<()> {
    blocking(move || index::apply_hunk(&worktree, &path, &hunk, reverse).map_err(err)).await
}

#[tauri::command]
async fn commit_create(worktree: PathBuf, message: String, amend: bool) -> R<String> {
    blocking(move || commit::create(&worktree, &message, amend).map_err(err)).await
}

#[tauri::command]
async fn sync_rebase(
    root: PathBuf,
    worktree: PathBuf,
    branch: String,
    base: String,
) -> R<SyncResult> {
    blocking(move || sync::rebase_onto(&repo(&root)?, &worktree, &branch, &base).map_err(err)).await
}

// ---- merge -----------------------------------------------------------------

#[tauri::command]
async fn merge_preflight(root: PathBuf, path: Option<PathBuf>, branch: String) -> R<Preflight> {
    blocking(move || {
        let r = repo(&root)?;
        let base = merge::default_base(&r).map_err(err)?;
        merge::preflight(&r, path.as_deref(), &branch, &base).map_err(err)
    })
    .await
}

#[tauri::command]
async fn merge_run(root: PathBuf, path: Option<PathBuf>, plan: MergePlan) -> R<MergeResult> {
    blocking(move || merge::run(&repo(&root)?, path.as_deref(), &plan).map_err(err)).await
}

// ---- conflicts -------------------------------------------------------------

#[tauri::command]
async fn conflict_file(worktree: PathBuf, path: String) -> R<ConflictFile> {
    blocking(move || conflict::file(&worktree, &path).map_err(err)).await
}

#[tauri::command]
async fn conflict_take(worktree: PathBuf, path: String, side: Side) -> R<()> {
    blocking(move || conflict::take(&worktree, &path, side).map_err(err)).await
}

#[tauri::command]
async fn conflict_resolve(worktree: PathBuf, path: String, content: String) -> R<()> {
    blocking(move || conflict::resolve(&worktree, &path, &content).map_err(err)).await
}

#[tauri::command]
async fn conflict_reset(worktree: PathBuf, path: String) -> R<()> {
    blocking(move || conflict::reset(&worktree, &path).map_err(err)).await
}

#[tauri::command]
async fn op_continue(worktree: PathBuf) -> R<Option<Operation>> {
    blocking(move || operation::continue_op(&worktree).map_err(err)).await
}

#[tauri::command]
async fn op_abort(worktree: PathBuf) -> R<()> {
    blocking(move || operation::abort(&worktree).map_err(err)).await
}

// ---- file watching ---------------------------------------------------------

/// One watcher per repo, shared by every window. Replaced when its worktrees change.
#[derive(Default)]
struct Watchers(Mutex<HashMap<PathBuf, (Vec<PathBuf>, watch::RepoWatcher)>>);

/// Watch a repo and its worktrees; emits `repo-changed` with the root when
/// something git would notice changes. Errors mean the app should keep polling.
#[tauri::command]
async fn watch_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, Watchers>,
    root: PathBuf,
    mut worktrees: Vec<PathBuf>,
) -> R<()> {
    worktrees.sort();
    if let Some((w, _)) = state.0.lock().map_err(err)?.get(&root) {
        if *w == worktrees {
            return Ok(());
        }
    }
    let (r, wts) = (root.clone(), worktrees.clone());
    let watcher = blocking(move || {
        let emit_root = r.clone();
        watch::watch(&repo(&r)?, &wts, move || {
            let _ = app.emit("repo-changed", &emit_root);
        })
        .map_err(err)
    })
    .await?;
    state
        .0
        .lock()
        .map_err(err)?
        .insert(root, (worktrees, watcher));
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Watchers::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            access_check,
            repos_list,
            repos_add,
            repos_remove,
            overview_load,
            fetch_all,
            branch_create,
            branch_push,
            branch_pull,
            branch_delete,
            worktree_move,
            worktree_lock,
            worktree_prune,
            branch_switch,
            branch_create_and_switch,
            watch_repo,
            branch_rename,
            branch_set_upstream,
            branch_delete_remote,
            commit_cherry_pick,
            commit_revert,
            tag_create,
            tag_delete,
            tag_push,
            remote_repos,
            repo_clone,
            prs_list,
            pr_add_worktree,
            backups_list,
            backup_restore_branch,
            backup_restore_files,
            backup_delete,
            stash_list,
            stash_save,
            stash_apply,
            stash_drop,
            stash_restore,
            worktree_path_preview,
            worktree_add,
            worktree_remove,
            worktree_undo_remove,
            terminal_name,
            open_terminal,
            log_list,
            commit_diff,
            commit_file_diff,
            compare,
            compare_file_diff,
            detail_load,
            diff_file,
            stage_paths,
            unstage_paths,
            stage_all,
            unstage_all,
            discard_paths,
            apply_hunk,
            commit_create,
            sync_rebase,
            merge_preflight,
            merge_run,
            conflict_file,
            conflict_take,
            conflict_resolve,
            conflict_reset,
            op_continue,
            op_abort
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Pando");
}
