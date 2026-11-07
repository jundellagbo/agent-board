use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::commands::orgs::non_empty;
use crate::db::{new_id, now, Db};
use crate::error::{Error, Result};
use crate::models::Task;

#[tauri::command]
pub fn list_tasks(db: State<Db>, project_id: String) -> Result<Vec<Task>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {} FROM tasks WHERE project_id = ?1 ORDER BY position, created_at",
            Task::COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![project_id], Task::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub plan: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub remote: Option<bool>,
    pub use_worktree: Option<bool>,
    pub github_url: Option<String>,
    pub github_kind: Option<String>,
    pub github_number: Option<i64>,
    pub branch: Option<String>,
    pub run_state: Option<String>,
}

/// A pasted issue or pull-request link becomes a real card: the title and body
/// come from GitHub, and a pull request also brings the branch to check out.
#[tauri::command]
pub async fn resolve_github(input: String) -> Result<crate::github::Resolved> {
    tauri::async_runtime::spawn_blocking(move || crate::github::resolve(&input))
        .await
        .map_err(|e| crate::error::Error::Invalid(e.to_string()))?
}

/// The id a card will have, reserved by the frontend before the card exists.
///
/// Files attached while a card is still being composed have to go somewhere,
/// and the tmp store is keyed by card id — so the composer picks the id first
/// and the paths it writes into the card's text are the ones that will still be
/// right afterwards. It becomes a directory name, so it is checked rather than
/// trusted.
fn reserved_id(id: Option<String>) -> Result<String> {
    let Some(id) = id else { return Ok(new_id()) };

    let usable = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !usable {
        return Err(Error::Invalid(format!("{id} is not a usable card id")));
    }
    Ok(id)
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    db: State<Db>,
    project_id: String,
    group_id: Option<String>,
    patch: TaskPatch,
    id: Option<String>,
) -> Result<Task> {
    let title = non_empty(patch.title.clone().unwrap_or_default(), "task title")?;
    let id = reserved_id(id)?;

    db.tx(|tx| {
        let group_id = match group_id {
            Some(id) => id,
            None => default_group(tx, &project_id)?,
        };
        let position: i64 = tx.query_row(
            "SELECT coalesce(max(position), -1) + 1 FROM tasks WHERE group_id = ?1",
            params![group_id],
            |r| r.get(0),
        )?;
        let ts = now();
        tx.execute(
            "INSERT INTO tasks (id, project_id, group_id, title, body, position, agent_id, model,
                                remote, github_url, github_kind, github_number, branch,
                                use_worktree, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![
                id,
                project_id,
                group_id,
                title,
                patch.body,
                position,
                patch.agent_id,
                patch.model,
                // Off unless the card asks for it; the column default stays 1
                // only so older rows read correctly.
                patch.remote.unwrap_or(false),
                patch.github_url,
                patch.github_kind,
                patch.github_number,
                patch.branch,
                // On unless the card says otherwise: two agents in one working
                // tree overwrite each other, so opting out is the exception.
                patch.use_worktree.unwrap_or(true),
                ts
            ],
        )?;
        get(tx, &id)
    })
    .inspect(|task| crate::board_events::announce(&app, &task.project_id))
}

#[tauri::command]
pub fn update_task(app: AppHandle, db: State<Db>, id: String, patch: TaskPatch) -> Result<Task> {
    db.with(|conn| {
        let current = get(conn, &id)?;
        let title = match &patch.title {
            Some(t) => non_empty(t.clone(), "task title")?,
            None => current.title,
        };
        conn.execute(
            "UPDATE tasks SET title = ?2, body = ?3, agent_id = ?4, model = ?5, github_url = ?6,
                              branch = ?7, run_state = ?8, remote = ?9, updated_at = ?10,
                              plan = ?11, use_worktree = ?12
             WHERE id = ?1",
            params![
                id,
                title,
                patch.body.or(current.body),
                patch.agent_id.or(current.agent_id),
                patch.model.or(current.model),
                patch.github_url.or(current.github_url),
                patch.branch.or(current.branch),
                patch.run_state.unwrap_or(current.run_state),
                patch.remote.unwrap_or(current.remote),
                now(),
                patch.plan.or(current.plan),
                patch.use_worktree.unwrap_or(current.use_worktree)
            ],
        )?;
        get(conn, &id)
    })
    .inspect(|task| crate::board_events::announce(&app, &task.project_id))
}

#[tauri::command]
pub fn delete_task(app: AppHandle, db: State<Db>, id: String) -> Result<()> {
    // Drop the checkout before the row: once the task is gone there is nothing
    // left pointing at the worktree, and git would keep it registered forever.
    db.with(|conn| {
        let task = get(conn, &id)?;
        if let Some(worktree) = task.worktree_path.as_deref() {
            let project = crate::commands::projects::get(conn, &task.project_id)?;
            let _ = crate::git::remove_worktree(
                std::path::Path::new(&project.path),
                std::path::Path::new(worktree),
            );
        }
        Ok(())
    })?;

    // Its scratch files go with it: nothing else points at them once the card
    // is gone, and they are the one part of a card that lives outside the
    // database. A failure here must not leave the card undeletable.
    if let Err(error) = crate::commands::tmp::clear(&app, &id) {
        log::warn!("could not remove the tmp files for {id}: {error}");
    }

    let project_id = db.with(|conn| Ok(get(conn, &id)?.project_id))?;
    db.tx(|tx| {
        let task = get(tx, &id)?;
        tx.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        close_gap(tx, &task.group_id, task.position)?;
        Ok(())
    })?;
    crate::board_events::announce(&app, &project_id);
    Ok(())
}

/// Drag-and-drop lands here: pull the card out of its old column, open a slot in
/// the new one, then drop it in. `position` past the end appends.
#[tauri::command]
pub fn move_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    group_id: String,
    position: i64,
) -> Result<Task> {
    db.tx(|tx| {
        let task = get(tx, &id)?;
        close_gap(tx, &task.group_id, task.position)?;

        let count: i64 = tx.query_row(
            "SELECT count(*) FROM tasks WHERE group_id = ?1 AND id != ?2",
            params![group_id, id],
            |r| r.get(0),
        )?;
        let target = position.clamp(0, count);

        tx.execute(
            "UPDATE tasks SET position = position + 1, updated_at = ?3
              WHERE group_id = ?1 AND position >= ?2 AND id != ?4",
            params![group_id, target, now(), id],
        )?;
        tx.execute(
            "UPDATE tasks SET group_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, group_id, target, now()],
        )?;

        get(tx, &id)
    })
    .inspect(|task| crate::board_events::announce(&app, &task.project_id))
}

#[tauri::command]
pub fn reorder_tasks(
    app: AppHandle,
    db: State<Db>,
    group_id: String,
    ids: Vec<String>,
) -> Result<()> {
    db.tx(|tx| {
        let ts = now();
        for (position, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE tasks SET group_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, group_id, position as i64, ts],
            )?;
        }
        Ok(())
    })?;

    if let Some(id) = ids.first() {
        let project_id = db.with(|conn| Ok(get(conn, id)?.project_id))?;
        crate::board_events::announce(&app, &project_id);
    }
    Ok(())
}

fn close_gap(conn: &Connection, group_id: &str, position: i64) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET position = position - 1 WHERE group_id = ?1 AND position > ?2",
        params![group_id, position],
    )?;
    Ok(())
}

fn default_group(conn: &Connection, project_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT id FROM board_groups WHERE project_id = ?1
         ORDER BY board_type = 'todo' DESC, position LIMIT 1",
        params![project_id],
        |r| r.get(0),
    )
    .map_err(|_| Error::Invalid("this project has no board groups".into()))
}

pub fn get(conn: &Connection, id: &str) -> Result<Task> {
    let sql = format!("SELECT {} FROM tasks WHERE id = ?1", Task::COLUMNS);
    conn.query_row(&sql, params![id], Task::from_row)
        .map_err(|_| Error::NotFound(format!("task {id}")))
}
