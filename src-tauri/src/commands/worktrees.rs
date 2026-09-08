use std::path::{Path, PathBuf};

use rusqlite::params;
use tauri::{AppHandle, Manager, State};

use crate::commands::{projects, tasks};
use crate::db::{now, Db};
use crate::error::{Error, Result};
use crate::git;
use crate::models::Task;

/// Worktrees live under the app's data dir, keyed by project, so a repo never
/// gains untracked directories and everything is removable in one place.
fn worktree_root(app: &AppHandle, project_id: &str) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("worktrees").join(project_id))
}

/// Gives a card its own checkout, or returns the one it already has. Returns
/// `None` when the project is not a repo or has worktrees switched off — that is
/// the "skippable for non-git tasks" path, not an error.
pub fn ensure(app: &AppHandle, db: &Db, task_id: &str) -> Result<Option<Task>> {
    let (task, project) = db.with(|conn| {
        let task = tasks::get(conn, task_id)?;
        let project = projects::get(conn, &task.project_id)?;
        Ok((task, project))
    })?;

    if task.worktree_path.is_some() {
        return Ok(Some(task));
    }
    let repo = Path::new(&project.path);
    if !project.use_worktrees || !git::is_repo(repo) {
        return Ok(None);
    }

    let branch = task.branch.clone().unwrap_or_else(|| git::branch_name(&task.title));
    // A pull-request card names a branch that may only exist on the remote.
    if !git::branch_exists(repo, &branch) {
        git::fetch_branch(repo, &branch);
    }
    let path = worktree_root(app, &project.id)?.join(branch.replace('/', "-"));
    let created = git::add_worktree(repo, &path, &branch)?;
    // A worktree is a new directory the agent has never seen, so it gets asked
    // about separately from the project it came from.
    if let Err(error) = crate::trust::trust(&created) {
        log::warn!("could not record workspace trust for the worktree: {error}");
    }

    db.with(|conn| {
        conn.execute(
            "UPDATE tasks SET branch = ?2, worktree_path = ?3, updated_at = ?4 WHERE id = ?1",
            params![task.id, branch, created.to_string_lossy(), now()],
        )?;
        Ok(())
    })?;

    db.with(|conn| tasks::get(conn, task_id)).map(Some)
}

#[tauri::command]
pub fn ensure_worktree(app: AppHandle, db: State<Db>, task_id: String) -> Result<Option<Task>> {
    ensure(&app, &db, &task_id)
}

#[tauri::command]
pub fn remove_worktree(db: State<Db>, task_id: String) -> Result<Task> {
    let (task, project) = db.with(|conn| {
        let task = tasks::get(conn, &task_id)?;
        let project = projects::get(conn, &task.project_id)?;
        Ok((task, project))
    })?;

    let path = task
        .worktree_path
        .clone()
        .ok_or_else(|| Error::Invalid("this card has no worktree".into()))?;
    git::remove_worktree(Path::new(&project.path), Path::new(&path))?;

    db.with(|conn| {
        conn.execute(
            "UPDATE tasks SET worktree_path = NULL, updated_at = ?2 WHERE id = ?1",
            params![task.id, now()],
        )?;
        tasks::get(conn, &task_id)
    })
}
