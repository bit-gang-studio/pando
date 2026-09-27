//! Thin Tauri shell. All logic is in pando-core.

use pando_core::{
    branch, commit, conflict, detail, diff, history, index, log, merge, operation, overview, sync,
    user_config, worktree, CommitDiff, ConflictFile, CreateWorktree, Created, Detail, FileDiff,
    Hunk, Log, MergePlan, MergeResult, Operation, Overview, Preflight, Repo, Side, SyncResult,
    UserConfig,
};
use std::path::PathBuf;

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

#[tauri::command]
fn version() -> &'static str {
    pando_core::VERSION
}

#[tauri::command]
fn doctor() -> pando_core::Doctor {
    pando_core::doctor()
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

#[tauri::command]
async fn user_config_save(config: UserConfig) -> R<()> {
    blocking(move || user_config::save(&config).map_err(err)).await
}

// ---- the list --------------------------------------------------------------

#[tauri::command]
async fn overview_load(root: PathBuf) -> R<Overview> {
    blocking(move || overview::load(&repo(&root)?).map_err(err)).await
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
async fn worktree_remove(root: PathBuf, path: PathBuf, force: bool) -> R<()> {
    blocking(move || worktree::remove(&repo(&root)?, &path, force).map_err(err)).await
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
async fn discard_paths(worktree: PathBuf, paths: Vec<String>, untracked: Vec<String>) -> R<()> {
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
async fn merge_preflight(root: PathBuf, path: PathBuf, branch: String) -> R<Preflight> {
    blocking(move || {
        let r = repo(&root)?;
        let base = merge::default_base(&r).map_err(err)?;
        merge::preflight(&r, &path, &branch, &base).map_err(err)
    })
    .await
}

#[tauri::command]
async fn merge_run(root: PathBuf, path: PathBuf, plan: MergePlan) -> R<MergeResult> {
    blocking(move || merge::run(&repo(&root)?, &path, &plan).map_err(err)).await
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            version,
            doctor,
            repos_list,
            repos_add,
            repos_remove,
            user_config_save,
            overview_load,
            fetch_all,
            branch_create,
            branch_push,
            branch_pull,
            branch_delete,
            worktree_path_preview,
            worktree_add,
            worktree_remove,
            log_list,
            commit_diff,
            commit_file_diff,
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
