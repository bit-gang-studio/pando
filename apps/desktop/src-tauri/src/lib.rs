//! Thin Tauri shell. All logic is in pando-core.

use pando_core::{board, launch, user_config, workspace, Board, Repo, UserConfig};
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
            workspace_remove,
            open_in_editor
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Pando");
}
