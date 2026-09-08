use rusqlite::params;
use tauri::State;

use crate::db::{new_id, now, Db};
use crate::error::{Error, Result};
use crate::models::Organization;

#[tauri::command]
pub fn list_orgs(db: State<Db>) -> Result<Vec<Organization>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {} FROM organizations ORDER BY position, created_at",
            Organization::COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], Organization::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[tauri::command]
pub fn create_org(db: State<Db>, name: String) -> Result<Organization> {
    let name = non_empty(name, "organization name")?;
    db.with(|conn| {
        let position: i64 =
            conn.query_row("SELECT coalesce(max(position), -1) + 1 FROM organizations", [], |r| {
                r.get(0)
            })?;
        let id = new_id();
        let ts = now();
        conn.execute(
            "INSERT INTO organizations (id, name, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, position, ts],
        )?;
        get(conn, &id)
    })
}

#[tauri::command]
pub fn rename_org(db: State<Db>, id: String, name: String) -> Result<Organization> {
    let name = non_empty(name, "organization name")?;
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE organizations SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(format!("organization {id}")));
        }
        get(conn, &id)
    })
}

/// Cascades to the org's projects, their groups and their tasks.
#[tauri::command]
pub fn delete_org(db: State<Db>, id: String) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM organizations WHERE id = ?1", params![id])?;
        Ok(())
    })
}

fn get(conn: &rusqlite::Connection, id: &str) -> Result<Organization> {
    let sql = format!(
        "SELECT {} FROM organizations WHERE id = ?1",
        Organization::COLUMNS
    );
    conn.query_row(&sql, params![id], Organization::from_row)
        .map_err(|_| Error::NotFound(format!("organization {id}")))
}

pub fn non_empty(value: String, field: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid(format!("{field} cannot be empty")));
    }
    Ok(trimmed.to_string())
}
