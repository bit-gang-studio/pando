//! Thin Tauri shell. All logic is in pando-core.

use pando_core::{
    branch, commit, conflict, detail, diff, history, index, log, merge, operation, overview,
    runtime, sync, user_config, worktree, CommitDiff, ConflictFile, CreateWorktree, Created,
    Detail, FileDiff, Hunk, Log, MergePlan, MergeResult, Operation, Overview, Preflight, Repo,
    RepoConfig, Side, SyncResult, UserConfig,
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

/// What the New branch dialog needs up front.
#[derive(serde::Serialize)]
struct BranchDefaults {
    base: Option<String>,
    next_port: Option<u16>,
    hooks: Vec<String>,
}

#[tauri::command]
async fn branch_defaults(root: PathBuf) -> R<BranchDefaults> {
    blocking(move || {
        let r = repo(&root)?;
        let cfg = RepoConfig::load(&r).map_err(err)?;
        let next_port = match &cfg.runtime.port {
            Some(pc) => Some(runtime::next_port(&r, pc).map_err(err)?),
            None => None,
        };
        Ok(BranchDefaults {
            base: cfg
                .worktree
                .base
                .clone()
                .or_else(|| r.default_branch.clone()),
            next_port,
            hooks: cfg.hooks.post_create,
        })
    })
    .await
}

#[tauri::command]
async fn worktree_path_preview(root: PathBuf, branch: String) -> R<String> {
    blocking(move || {
        let r = repo(&root)?;
        let cfg = RepoConfig::load(&r).map_err(err)?;
        Ok(cfg
            .worktree_path(&r, &branch)
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

// ---- settings --------------------------------------------------------------

#[tauri::command]
async fn config_load(root: PathBuf) -> R<RepoConfig> {
    blocking(move || RepoConfig::load(&repo(&root)?).map_err(err)).await
}

#[tauri::command]
async fn config_render(config: RepoConfig) -> R<String> {
    blocking(move || config.to_toml().map_err(err)).await
}

#[tauri::command]
async fn config_save(root: PathBuf, config: RepoConfig) -> R<String> {
    blocking(move || config.save(&repo(&root)?).map_err(err)).await
}

#[tauri::command]
async fn config_commit(root: PathBuf) -> R<()> {
    blocking(move || {
        pando_core::config::commit(&repo(&root)?, "chore: update .pando.toml").map_err(err)
    })
    .await
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
            branch_defaults,
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
            op_abort,
            config_load,
            config_render,
            config_save,
            config_commit
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Pando");
}
