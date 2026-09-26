//! Thin Tauri shell. All logic is in pando-core.

use pando_core::{
    board, branch, commit, detail, diff, history, index, launch, runtime, stash, sync, tag,
    user_config, worktree, Board, Branch, CommitDiff, CreateWorktree, Created, Detail, FileDiff,
    History, Hunk, RemoteBranch, Repo, RepoConfig, Stash, SyncResult, Tag, UserConfig,
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

#[tauri::command]
fn version() -> &'static str {
    pando_core::VERSION
}

#[tauri::command]
fn doctor() -> pando_core::Doctor {
    pando_core::doctor()
}

#[tauri::command]
async fn repos_list() -> R<UserConfig> {
    blocking(move || user_config::load().map_err(err)).await
}

#[tauri::command]
async fn repos_add(path: PathBuf) -> R<UserConfig> {
    blocking(move || {
        let repo = Repo::discover(&path).map_err(err)?;
        user_config::add_repo(&repo.root).map_err(err)
    })
    .await
}

#[tauri::command]
async fn repos_remove(path: PathBuf) -> R<UserConfig> {
    blocking(move || user_config::remove_repo(&path).map_err(err)).await
}

#[tauri::command]
async fn board_load(root: PathBuf) -> R<Board> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        board::load(&repo).map_err(err)
    })
    .await
}

#[tauri::command]
async fn worktree_remove(root: PathBuf, path: PathBuf, force: bool) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        worktree::remove(&repo, &path, force).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branches_list(root: PathBuf) -> R<Vec<Branch>> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::list(&repo).map_err(err)
    })
    .await
}

/// What the New worktree dialog needs up front.
#[derive(serde::Serialize)]
struct CreateDefaults {
    config: RepoConfig,
    default_branch: Option<String>,
    next_port: Option<u16>,
    branches: Vec<Branch>,
}

#[tauri::command]
async fn create_defaults(root: PathBuf) -> R<CreateDefaults> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        let config = RepoConfig::load(&repo).map_err(err)?;
        let next_port = match &config.runtime.port {
            Some(pc) => Some(runtime::next_port(&repo, pc).map_err(err)?),
            None => None,
        };
        Ok(CreateDefaults {
            default_branch: config
                .worktree
                .base
                .clone()
                .or_else(|| repo.default_branch.clone()),
            next_port,
            branches: branch::list(&repo).map_err(err)?,
            config,
        })
    })
    .await
}

#[tauri::command]
async fn worktree_path_preview(root: PathBuf, branch: String) -> R<String> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        let config = RepoConfig::load(&repo).map_err(err)?;
        Ok(config
            .worktree_path(&repo, &branch)
            .to_string_lossy()
            .into_owned())
    })
    .await
}

#[tauri::command]
async fn worktree_create(root: PathBuf, req: CreateWorktree) -> R<Created> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        worktree::create(&repo, &req).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branches_remote(root: PathBuf) -> R<Vec<RemoteBranch>> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::list_remote(&repo).map_err(err)
    })
    .await
}

#[tauri::command]
async fn history_linear(root: PathBuf, rev: String, limit: usize) -> R<History> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        history::linear(&repo, &rev, limit).map_err(err)
    })
    .await
}

#[tauri::command]
async fn commit_diff(root: PathBuf, id: String) -> R<CommitDiff> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        history::commit_diff(&repo, &id).map_err(err)
    })
    .await
}

#[tauri::command]
async fn stashes_list(root: PathBuf) -> R<Vec<Stash>> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        stash::list(&repo).map_err(err)
    })
    .await
}

#[tauri::command]
async fn stash_apply(worktree: PathBuf, index: u32, pop: bool) -> R<()> {
    blocking(move || {
        if pop {
            stash::pop(&worktree, index).map_err(err)
        } else {
            stash::apply(&worktree, index).map_err(err)
        }
    })
    .await
}

#[tauri::command]
async fn stash_drop(root: PathBuf, index: u32) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        stash::drop(&repo, index).map_err(err)
    })
    .await
}

#[tauri::command]
async fn tags_list(root: PathBuf) -> R<Vec<Tag>> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        tag::list(&repo).map_err(err)
    })
    .await
}

/// Switch the main worktree. With `stash_first`, dirty changes are stashed and re-applied.
#[tauri::command]
async fn branch_switch_main(root: PathBuf, name: String, stash_first: bool) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        let stashed = if stash_first {
            stash::save(&repo.root, Some(&format!("pando: switch to {name}"))).map_err(err)?
        } else {
            false
        };
        branch::switch_in_main(&repo, &name).map_err(err)?;
        if stashed {
            stash::pop(&repo.root, 0).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn branch_create(root: PathBuf, name: String, base: Option<String>) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::create(&repo, &name, base.as_deref()).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branch_track_remote(root: PathBuf, remote_branch: String, local: String) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::track_remote(&repo, &remote_branch, &local).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branch_rename(root: PathBuf, old: String, new: String) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::rename(&repo, &old, &new).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branch_delete(root: PathBuf, name: String, force: bool, remote: Option<String>) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::delete(&repo, &name, force).map_err(err)?;
        if let Some(r) = remote {
            branch::delete_remote(&repo, &r, &name).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn fetch_all(root: PathBuf) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::fetch_all(&repo).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branch_push(root: PathBuf, name: String, force_with_lease: bool) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        branch::push(&repo, &name, "origin", force_with_lease).map_err(err)
    })
    .await
}

#[tauri::command]
async fn branch_pull(worktree: PathBuf, rebase: bool) -> R<()> {
    blocking(move || branch::pull(&worktree, rebase).map_err(err)).await
}

#[tauri::command]
async fn config_load(root: PathBuf) -> R<RepoConfig> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        RepoConfig::load(&repo).map_err(err)
    })
    .await
}

#[tauri::command]
async fn config_render(config: RepoConfig) -> R<String> {
    blocking(move || config.to_toml().map_err(err)).await
}

#[tauri::command]
async fn config_save(root: PathBuf, config: RepoConfig) -> R<String> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        config.save(&repo).map_err(err)
    })
    .await
}

#[tauri::command]
async fn config_commit(root: PathBuf) -> R<()> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        pando_core::config::commit(&repo, "chore: update .pando.toml").map_err(err)
    })
    .await
}

#[tauri::command]
async fn user_config_save(config: UserConfig) -> R<()> {
    blocking(move || user_config::save(&config).map_err(err)).await
}

#[tauri::command]
async fn detail_load(root: PathBuf, path: PathBuf) -> R<Detail> {
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        detail::load(&repo, &path).map_err(err)
    })
    .await
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
    blocking(move || {
        let repo = Repo::discover(&root).map_err(err)?;
        sync::rebase_onto(&repo, &worktree, &branch, &base).map_err(err)
    })
    .await
}

#[tauri::command]
async fn open_in_editor(path: PathBuf) -> R<()> {
    blocking(move || {
        let editor = user_config::load().ok().and_then(|c| c.editor);
        launch::open_in_editor(&path, editor.as_deref()).map_err(err)
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
            board_load,
            branches_list,
            create_defaults,
            worktree_path_preview,
            worktree_create,
            worktree_remove,
            branches_remote,
            history_linear,
            commit_diff,
            stashes_list,
            stash_apply,
            stash_drop,
            tags_list,
            branch_switch_main,
            branch_create,
            branch_track_remote,
            branch_rename,
            branch_delete,
            fetch_all,
            branch_push,
            branch_pull,
            config_load,
            config_render,
            config_save,
            config_commit,
            user_config_save,
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
            open_in_editor
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Pando");
}
