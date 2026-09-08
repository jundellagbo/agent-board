use std::collections::HashMap;

use rusqlite::params;
use tauri::State;

use crate::db::{now, Db};
use crate::error::Result;

/// A flat key/value store. Settings are read as a whole at startup and written
/// one key at a time, so there is no schema to migrate when a preference is
/// added or dropped.
#[tauri::command]
pub fn get_settings(db: State<Db>) -> Result<HashMap<String, String>> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<HashMap<String, String>>>()?)
    })
}

#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            params![key, value, now()],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn clear_setting(db: State<Db>, key: String) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    })
}
