//! Thin Tauri shell. All logic is in pando-core.

use pando_core::{
    board, branch, history, launch, runtime, stash, tag, user_config, workspace, Board, Branch,
    CommitDiff, CreateWorkspace, Created, History, RemoteBranch, Repo, RepoConfig, Stash, Tag,
    UserConfig,
};
use std::path::PathBuf;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
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
fn repos_list() -> R<UserConfig> {
    user_config::load().map_err(err)
}

#[tauri::command]
fn repos_add(path: PathBuf) -> R<UserConfig> {
    let repo = Repo::discover(&path).map_err(err)?;
    user_config::add_repo(&repo.root).map_err(err)
}

#[tauri::command]
fn repos_remove(path: PathBuf) -> R<UserConfig> {
    user_config::remove_repo(&path).map_err(err)
}

#[tauri::command]
fn board_load(root: PathBuf) -> R<Board> {
    let repo = Repo::discover(&root).map_err(err)?;
    board::load(&repo).map_err(err)
}

#[tauri::command]
fn workspace_remove(root: PathBuf, path: PathBuf, force: bool) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    workspace::remove(&repo, &path, force).map_err(err)
}

#[tauri::command]
fn branches_list(root: PathBuf) -> R<Vec<Branch>> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::list(&repo).map_err(err)
}

/// What the New workspace dialog needs up front.
#[derive(serde::Serialize)]
struct CreateDefaults {
    config: RepoConfig,
    default_branch: Option<String>,
    next_port: Option<u16>,
    branches: Vec<Branch>,
}

#[tauri::command]
fn create_defaults(root: PathBuf) -> R<CreateDefaults> {
    let repo = Repo::discover(&root).map_err(err)?;
    let config = RepoConfig::load(&repo).map_err(err)?;
    let next_port = match &config.runtime.port {
        Some(pc) => Some(runtime::next_port(&repo, pc).map_err(err)?),
        None => None,
    };
    Ok(CreateDefaults {
        default_branch: config
            .workspace
            .base
            .clone()
            .or_else(|| repo.default_branch.clone()),
        next_port,
        branches: branch::list(&repo).map_err(err)?,
        config,
    })
}

#[tauri::command]
fn workspace_path_preview(root: PathBuf, branch: String) -> R<String> {
    let repo = Repo::discover(&root).map_err(err)?;
    let config = RepoConfig::load(&repo).map_err(err)?;
    Ok(config
        .workspace_path(&repo, &branch)
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
fn workspace_create(root: PathBuf, req: CreateWorkspace) -> R<Created> {
    let repo = Repo::discover(&root).map_err(err)?;
    workspace::create(&repo, &req).map_err(err)
}

#[tauri::command]
fn branches_remote(root: PathBuf) -> R<Vec<RemoteBranch>> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::list_remote(&repo).map_err(err)
}

#[tauri::command]
fn history_linear(root: PathBuf, rev: String, limit: usize) -> R<History> {
    let repo = Repo::discover(&root).map_err(err)?;
    history::linear(&repo, &rev, limit).map_err(err)
}

#[tauri::command]
fn commit_diff(root: PathBuf, id: String) -> R<CommitDiff> {
    let repo = Repo::discover(&root).map_err(err)?;
    history::commit_diff(&repo, &id).map_err(err)
}

#[tauri::command]
fn stashes_list(root: PathBuf) -> R<Vec<Stash>> {
    let repo = Repo::discover(&root).map_err(err)?;
    stash::list(&repo).map_err(err)
}

#[tauri::command]
fn stash_apply(worktree: PathBuf, index: u32, pop: bool) -> R<()> {
    if pop {
        stash::pop(&worktree, index).map_err(err)
    } else {
        stash::apply(&worktree, index).map_err(err)
    }
}

#[tauri::command]
fn stash_drop(root: PathBuf, index: u32) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    stash::drop(&repo, index).map_err(err)
}

#[tauri::command]
fn tags_list(root: PathBuf) -> R<Vec<Tag>> {
    let repo = Repo::discover(&root).map_err(err)?;
    tag::list(&repo).map_err(err)
}

/// Switch the main worktree. With `stash_first`, dirty changes are stashed and re-applied.
#[tauri::command]
fn branch_switch_main(root: PathBuf, name: String, stash_first: bool) -> R<()> {
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
}

#[tauri::command]
fn branch_create(root: PathBuf, name: String, base: Option<String>) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::create(&repo, &name, base.as_deref()).map_err(err)
}

#[tauri::command]
fn branch_track_remote(root: PathBuf, remote_branch: String, local: String) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::track_remote(&repo, &remote_branch, &local).map_err(err)
}

#[tauri::command]
fn branch_rename(root: PathBuf, old: String, new: String) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::rename(&repo, &old, &new).map_err(err)
}

#[tauri::command]
fn branch_delete(root: PathBuf, name: String, force: bool, remote: Option<String>) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::delete(&repo, &name, force).map_err(err)?;
    if let Some(r) = remote {
        branch::delete_remote(&repo, &r, &name).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn fetch_all(root: PathBuf) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::fetch_all(&repo).map_err(err)
}

#[tauri::command]
fn branch_push(root: PathBuf, name: String, force_with_lease: bool) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    branch::push(&repo, &name, "origin", force_with_lease).map_err(err)
}

#[tauri::command]
fn branch_pull(worktree: PathBuf, rebase: bool) -> R<()> {
    branch::pull(&worktree, rebase).map_err(err)
}

#[tauri::command]
fn config_load(root: PathBuf) -> R<RepoConfig> {
    let repo = Repo::discover(&root).map_err(err)?;
    RepoConfig::load(&repo).map_err(err)
}

#[tauri::command]
fn config_render(config: RepoConfig) -> R<String> {
    config.to_toml().map_err(err)
}

#[tauri::command]
fn config_save(root: PathBuf, config: RepoConfig) -> R<String> {
    let repo = Repo::discover(&root).map_err(err)?;
    config.save(&repo).map_err(err)
}

#[tauri::command]
fn config_commit(root: PathBuf) -> R<()> {
    let repo = Repo::discover(&root).map_err(err)?;
    pando_core::config::commit(&repo, "chore: update .pando.toml").map_err(err)
}

#[tauri::command]
fn user_config_save(config: UserConfig) -> R<()> {
    user_config::save(&config).map_err(err)
}

#[tauri::command]
fn open_in_editor(path: PathBuf) -> R<()> {
    let editor = user_config::load().ok().and_then(|c| c.editor);
    launch::open_in_editor(&path, editor.as_deref()).map_err(err)
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
            workspace_path_preview,
            workspace_create,
            workspace_remove,
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
            open_in_editor
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Pando");
}
