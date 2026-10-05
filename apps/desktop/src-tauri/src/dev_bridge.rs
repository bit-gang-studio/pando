//! Debug builds only: the app's real commands, callable by name, for the
//! browser test bridge (examples/bridge.rs). Generated from lib.rs.
//! The file watcher is real (on the paths the test asks for). Terminal and gh
//! are stubbed: nothing opens on screen and nothing talks to GitHub.

use serde_json::Value;
use std::sync::Mutex;

static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static WATCHERS: std::sync::LazyLock<
    Mutex<std::collections::HashMap<String, pando_core::watch::RepoWatcher>>,
> = std::sync::LazyLock::new(Default::default);

fn arg<T: serde::de::DeserializeOwned>(a: &Value, k: &str) -> Result<T, String> {
    serde_json::from_value(a.get(k).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("arg {k}: {e}"))
}

fn out<T: serde::Serialize, E: std::fmt::Display>(r: Result<T, E>) -> Result<Value, String> {
    r.map(|v| serde_json::to_value(v).unwrap())
        .map_err(|e| e.to_string())
}

#[allow(clippy::unit_arg)]
pub async fn dispatch(cmd: &str, a: Value) -> Result<Value, String> {
    match cmd {
        "access_check" => out(super::access_check(arg(&a, "paths")?).await),
        "repos_list" => out(super::repos_list().await),
        "repos_add" => out(super::repos_add(arg(&a, "path")?).await),
        "repos_remove" => out(super::repos_remove(arg(&a, "path")?).await),
        "overview_load" => out(super::overview_load(arg(&a, "root")?, arg(&a, "quick")?).await),
        "fetch_all" => out(super::fetch_all(arg(&a, "root")?).await),
        "branch_create" => {
            out(super::branch_create(arg(&a, "root")?, arg(&a, "name")?, arg(&a, "base")?).await)
        }
        "branch_push" => out(super::branch_push(arg(&a, "root")?, arg(&a, "name")?).await),
        "branch_pull" => out(super::branch_pull(arg(&a, "worktree")?).await),
        "branch_delete" => {
            out(super::branch_delete(arg(&a, "root")?, arg(&a, "name")?, arg(&a, "remote")?).await)
        }
        "worktree_path_preview" => {
            out(super::worktree_path_preview(arg(&a, "root")?, arg(&a, "branch")?).await)
        }
        "worktree_add" => out(super::worktree_add(arg(&a, "root")?, arg(&a, "req")?).await),
        "worktree_remove" => {
            out(super::worktree_remove(arg(&a, "root")?, arg(&a, "path")?, arg(&a, "force")?).await)
        }
        "terminal_name" => Ok(Value::String("Terminal".into())),
        "open_terminal" => {
            OPENED.lock().unwrap().push(a.to_string());
            Ok(Value::Null)
        }
        "worktree_undo_remove" => {
            out(super::worktree_undo_remove(arg(&a, "root")?, arg(&a, "removed")?).await)
        }
        "worktree_move" => {
            out(super::worktree_move(arg(&a, "root")?, arg(&a, "from")?, arg(&a, "to")?).await)
        }
        "worktree_lock" => {
            out(super::worktree_lock(arg(&a, "root")?, arg(&a, "path")?, arg(&a, "locked")?).await)
        }
        "worktree_prune" => out(super::worktree_prune(arg(&a, "root")?).await),
        "worktree_repair" => out(super::worktree_repair(arg(&a, "root")?, arg(&a, "path")?).await),
        "branch_switch" => out(super::branch_switch(arg(&a, "root")?, arg(&a, "name")?).await),
        "branch_create_and_switch" => {
            out(super::branch_create_and_switch(arg(&a, "path")?, arg(&a, "name")?).await)
        }
        "branch_rename" => {
            out(super::branch_rename(arg(&a, "root")?, arg(&a, "old")?, arg(&a, "new")?).await)
        }
        "branch_set_upstream" => out(super::branch_set_upstream(
            arg(&a, "root")?,
            arg(&a, "name")?,
            arg(&a, "upstream")?,
        )
        .await),
        "branch_delete_remote" => {
            out(super::branch_delete_remote(arg(&a, "root")?, arg(&a, "name")?).await)
        }
        "commit_cherry_pick" => {
            out(
                super::commit_cherry_pick(arg(&a, "root")?, arg(&a, "worktree")?, arg(&a, "id")?)
                    .await,
            )
        }
        "commit_revert" => {
            out(super::commit_revert(arg(&a, "root")?, arg(&a, "worktree")?, arg(&a, "id")?).await)
        }
        "tag_delete" => out(super::tag_delete(arg(&a, "root")?, arg(&a, "name")?).await),
        "tag_push" => out(super::tag_push(arg(&a, "root")?, arg(&a, "name")?).await),
        "remote_repos" => Ok(Value::Null),
        "repo_clone" => out(super::repo_clone(arg(&a, "source")?, arg(&a, "parent")?).await),
        "overlaps" => out(super::overlaps(arg(&a, "root")?).await),
        "prs_list" => Ok(serde_json::json!({"state":"no_gh"})),
        "pr_add_worktree" => out(super::pr_add_worktree(arg(&a, "root")?, arg(&a, "pr")?).await),
        "backups_list" => out(super::backups_list(arg(&a, "root")?).await),
        "backup_restore_branch" => {
            out(super::backup_restore_branch(arg(&a, "root")?, arg(&a, "refname")?).await)
        }
        "backup_restore_files" => out(super::backup_restore_files(
            arg(&a, "root")?,
            arg(&a, "refname")?,
            arg(&a, "worktree")?,
        )
        .await),
        "backup_delete" => out(super::backup_delete(arg(&a, "root")?, arg(&a, "refname")?).await),
        "tag_create" => out(super::tag_create(
            arg(&a, "root")?,
            arg(&a, "name")?,
            arg(&a, "target")?,
            arg(&a, "message")?,
            arg(&a, "push")?,
        )
        .await),
        "stash_list" => out(super::stash_list(arg(&a, "root")?).await),
        "stash_save" => out(super::stash_save(arg(&a, "worktree")?, arg(&a, "message")?).await),
        "stash_apply" => {
            out(super::stash_apply(arg(&a, "worktree")?, arg(&a, "index")?, arg(&a, "pop")?).await)
        }
        "stash_restore" => {
            out(super::stash_restore(arg(&a, "root")?, arg(&a, "kept")?, arg(&a, "message")?).await)
        }
        "stash_drop" => out(super::stash_drop(arg(&a, "root")?, arg(&a, "index")?).await),
        "log_list" => out(super::log_list(
            arg(&a, "root")?,
            arg(&a, "branch")?,
            arg(&a, "skip")?,
            arg(&a, "limit")?,
        )
        .await),
        "commit_diff" => out(super::commit_diff(arg(&a, "root")?, arg(&a, "id")?).await),
        "branch_force_push" => {
            out(super::branch_force_push(arg(&a, "root")?, arg(&a, "name")?).await)
        }
        "rewrite_pushed" => out(super::rewrite_pushed(arg(&a, "root")?, arg(&a, "branch")?).await),
        "rewrite_editable" => {
            out(super::rewrite_editable(arg(&a, "root")?, arg(&a, "branch")?).await)
        }
        "commit_reword" => out(super::commit_reword(
            arg(&a, "root")?,
            arg(&a, "branch")?,
            arg(&a, "id")?,
            arg(&a, "message")?,
        )
        .await),
        "commit_squash" => out(super::commit_squash(
            arg(&a, "root")?,
            arg(&a, "branch")?,
            arg(&a, "older")?,
            arg(&a, "newer")?,
            arg(&a, "message")?,
        )
        .await),
        "commit_drop" => {
            out(super::commit_drop(arg(&a, "root")?, arg(&a, "branch")?, arg(&a, "id")?).await)
        }
        "rewrite_undo" => out(super::rewrite_undo(
            arg(&a, "root")?,
            arg(&a, "branch")?,
            arg(&a, "from")?,
            arg(&a, "to")?,
        )
        .await),
        "commit_range" => {
            out(super::commit_range(arg(&a, "root")?, arg(&a, "older")?, arg(&a, "newer")?).await)
        }
        "commit_range_file_diff" => out(super::commit_range_file_diff(
            arg(&a, "root")?,
            arg(&a, "base")?,
            arg(&a, "newer")?,
            arg(&a, "path")?,
        )
        .await),
        "compare" => {
            out(super::compare(arg(&a, "root")?, arg(&a, "base")?, arg(&a, "head")?).await)
        }
        "compare_file_diff" => out(super::compare_file_diff(
            arg(&a, "root")?,
            arg(&a, "base")?,
            arg(&a, "head")?,
            arg(&a, "path")?,
        )
        .await),
        "commit_file_diff" => {
            out(super::commit_file_diff(arg(&a, "root")?, arg(&a, "id")?, arg(&a, "path")?).await)
        }
        "detail_load" => out(super::detail_load(arg(&a, "root")?, arg(&a, "path")?).await),
        "diff_file" => out(super::diff_file(
            arg(&a, "worktree")?,
            arg(&a, "path")?,
            arg(&a, "staged")?,
            arg(&a, "untracked")?,
        )
        .await),
        "stage_paths" => out(super::stage_paths(arg(&a, "worktree")?, arg(&a, "paths")?).await),
        "unstage_paths" => out(super::unstage_paths(arg(&a, "worktree")?, arg(&a, "paths")?).await),
        "stage_all" => out(super::stage_all(arg(&a, "worktree")?).await),
        "unstage_all" => out(super::unstage_all(arg(&a, "worktree")?).await),
        "discard_paths" => out(super::discard_paths(
            arg(&a, "worktree")?,
            arg(&a, "paths")?,
            arg(&a, "untracked")?,
        )
        .await),
        "apply_lines" => out(super::apply_lines(
            arg(&a, "worktree")?,
            arg(&a, "path")?,
            arg(&a, "hunk")?,
            arg(&a, "lines")?,
            arg(&a, "reverse")?,
        )
        .await),
        "apply_hunk" => out(super::apply_hunk(
            arg(&a, "worktree")?,
            arg(&a, "path")?,
            arg(&a, "hunk")?,
            arg(&a, "reverse")?,
        )
        .await),
        "commit_create" => {
            out(
                super::commit_create(arg(&a, "worktree")?, arg(&a, "message")?, arg(&a, "amend")?)
                    .await,
            )
        }
        "sync_rebase" => out(super::sync_rebase(
            arg(&a, "root")?,
            arg(&a, "worktree")?,
            arg(&a, "branch")?,
            arg(&a, "base")?,
        )
        .await),
        "merge_preflight" => {
            out(
                super::merge_preflight(arg(&a, "root")?, arg(&a, "path")?, arg(&a, "branch")?)
                    .await,
            )
        }
        "merge_run" => {
            out(super::merge_run(arg(&a, "root")?, arg(&a, "path")?, arg(&a, "plan")?).await)
        }
        "conflict_file" => out(super::conflict_file(arg(&a, "worktree")?, arg(&a, "path")?).await),
        "conflict_take" => {
            out(
                super::conflict_take(arg(&a, "worktree")?, arg(&a, "path")?, arg(&a, "side")?)
                    .await,
            )
        }
        "conflict_choose" => {
            out(
                super::conflict_choose(arg(&a, "worktree")?, arg(&a, "path")?, arg(&a, "choices")?)
                    .await,
            )
        }
        "conflict_resolve" => out(super::conflict_resolve(
            arg(&a, "worktree")?,
            arg(&a, "path")?,
            arg(&a, "content")?,
        )
        .await),
        "conflict_reset" => {
            out(super::conflict_reset(arg(&a, "worktree")?, arg(&a, "path")?).await)
        }
        "op_continue" => out(super::op_continue(arg(&a, "worktree")?).await),
        "op_abort" => out(super::op_abort(arg(&a, "worktree")?).await),
        // The real watcher, on the paths the test page asks for (the throwaway
        // repo). Changes queue up here; the page picks them up via "__events".
        "watch_repo" => {
            let root: std::path::PathBuf = arg(&a, "root")?;
            let worktrees: Vec<std::path::PathBuf> = arg(&a, "worktrees")?;
            let repo = pando_core::Repo::discover(&root).map_err(|e| e.to_string())?;
            let key = root.to_string_lossy().into_owned();
            let emit = key.clone();
            let w = pando_core::watch::watch(&repo, &worktrees, move || {
                EVENTS.lock().unwrap().push(emit.clone())
            })
            .map_err(|e| e.to_string())?;
            WATCHERS.lock().unwrap().insert(key, w);
            Ok(Value::Null)
        }
        "__events" => {
            Ok(serde_json::to_value(std::mem::take(&mut *EVENTS.lock().unwrap())).unwrap())
        }
        "__opened" => Ok(serde_json::to_value(OPENED.lock().unwrap().clone()).unwrap()),
        other => Err(format!("bridge: unknown command {other}")),
    }
}
