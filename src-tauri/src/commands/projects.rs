use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use tauri::State;

use crate::commands::groups::seed_defaults;
use crate::commands::orgs::non_empty;
use crate::db::{new_id, now, Db};
use crate::error::{Error, Result};
use crate::models::Project;

#[tauri::command]
pub fn list_projects(db: State<Db>, org_id: Option<String>) -> Result<Vec<Project>> {
    db.with(|conn| {
        let mut sql = format!("SELECT {} FROM projects", Project::COLUMNS);
        if org_id.is_some() {
            sql.push_str(" WHERE org_id = ?1");
        }
        sql.push_str(" ORDER BY position, created_at");

        let mut stmt = conn.prepare(&sql)?;
        let rows = match &org_id {
            Some(org) => stmt.query_map(params![org], Project::from_row)?,
            None => stmt.query_map([], Project::from_row)?,
        };
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[tauri::command]
pub fn create_project(
    db: State<Db>,
    org_id: String,
    path: String,
    name: Option<String>,
) -> Result<Project> {
    let dir = canonical_dir(&path)?;
    let name = match name {
        Some(n) => non_empty(n, "project name")?,
        None => dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.display().to_string()),
    };
    let path = dir.display().to_string();
    let is_git = dir.join(".git").exists();

    // Adding a directory here is the person saying they trust it; record that
    // for the agent CLI so an unattended run is not stopped by its prompt.
    if let Err(error) = crate::trust::trust(&dir) {
        log::warn!("could not record workspace trust for {}: {error}", dir.display());
    }

    db.tx(|conn| {
        let position: i64 = conn.query_row(
            "SELECT coalesce(max(position), -1) + 1 FROM projects WHERE org_id = ?1",
            params![org_id],
            |r| r.get(0),
        )?;
        let id = new_id();
        let ts = now();
        conn.execute(
            "INSERT INTO projects (id, org_id, name, path, is_git, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, org_id, name, path, is_git, position, ts],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Error::Invalid("that directory is already a project in this organization".into())
            }
            other => other.into(),
        })?;
        seed_defaults(conn, &id)?;
        get(conn, &id)
    })
}

#[tauri::command]
pub fn update_project(
    db: State<Db>,
    id: String,
    name: Option<String>,
    agent_id: Option<String>,
    use_worktrees: Option<bool>,
    auto_run: Option<bool>,
) -> Result<Project> {
    db.with(|conn| {
        let current = get(conn, &id)?;
        let name = match name {
            Some(n) => non_empty(n, "project name")?,
            None => current.name,
        };
        conn.execute(
            "UPDATE projects SET name = ?2, agent_id = ?3, use_worktrees = ?4, auto_run = ?5,
                                 updated_at = ?6
             WHERE id = ?1",
            params![
                id,
                name,
                agent_id.or(current.agent_id),
                use_worktrees.unwrap_or(current.use_worktrees),
                auto_run.unwrap_or(current.auto_run),
                now()
            ],
        )?;
        get(conn, &id)
    })
}

#[tauri::command]
pub fn delete_project(db: State<Db>, id: String) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    })
}

pub fn get(conn: &Connection, id: &str) -> Result<Project> {
    let sql = format!("SELECT {} FROM projects WHERE id = ?1", Project::COLUMNS);
    conn.query_row(&sql, params![id], Project::from_row)
        .map_err(|_| Error::NotFound(format!("project {id}")))
}

/// Projects are keyed by path, so resolve symlinks and `..` before storing —
/// otherwise the same directory can be added twice under different spellings.
fn canonical_dir(path: &str) -> Result<PathBuf> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() {
        return Err(Error::Invalid("choose a project directory".into()));
    }
    let dir = std::fs::canonicalize(path)
        .map_err(|_| Error::Invalid(format!("{} does not exist", path.display())))?;
    if !dir.is_dir() {
        return Err(Error::Invalid(format!("{} is not a directory", dir.display())));
    }
    Ok(dir)
}
