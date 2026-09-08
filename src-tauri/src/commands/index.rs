use std::path::Path;

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::projects;
use crate::db::{now, Db};
use crate::error::Result;
use crate::indexer;
use crate::models::Project;

pub const INDEXED_EVENT: &str = "project://indexed";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub project_id: String,
    pub status: String,
    pub files: i64,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
}

/// Indexing walks the disk, so it runs off the UI thread and reports back with
/// an event. The row's `index_status` is the single source of truth for the
/// button's label, which is why it is written before the work starts.
#[tauri::command]
pub fn index_project(app: AppHandle, db: State<Db>, project_id: String) -> Result<()> {
    let project = db.with(|conn| projects::get(conn, &project_id))?;
    set_status(&db, &project.id, "indexing")?;

    let handle = app.clone();
    std::thread::spawn(move || {
        let db = handle.state::<Db>();
        let outcome = build(&db, &project);
        let status = match &outcome {
            Ok(files) => IndexStatus {
                project_id: project.id.clone(),
                status: "indexed".into(),
                files: *files,
                message: None,
            },
            Err(error) => IndexStatus {
                project_id: project.id.clone(),
                status: "error".into(),
                files: 0,
                message: Some(error.to_string()),
            },
        };
        let _ = set_status(&db, &project.id, &status.status);
        let _ = handle.emit(INDEXED_EVENT, status);
    });

    Ok(())
}

#[tauri::command]
pub fn unindex_project(db: State<Db>, project_id: String) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM project_files WHERE project_id = ?1", params![project_id])?;
        conn.execute(
            "UPDATE projects SET index_status = 'none', indexed_at = NULL, updated_at = ?2
             WHERE id = ?1",
            params![project_id, now()],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn indexed_files(db: State<Db>, project_id: String) -> Result<i64> {
    db.with(|conn| {
        Ok(conn.query_row(
            "SELECT count(*) FROM project_files WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?)
    })
}

#[tauri::command]
pub fn search_project(
    db: State<Db>,
    project_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>> {
    db.with(|conn| search(conn, &project_id, &query, limit))
}

fn search(
    conn: &rusqlite::Connection,
    project_id: &str,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>> {
    let mut stmt = conn.prepare(
        "SELECT path, snippet(project_files, 2, '[', ']', '…', 12)
           FROM project_files
          WHERE project_files MATCH ?2 AND project_id = ?1
          ORDER BY rank
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![project_id, query, limit.unwrap_or(50)], |row| {
        Ok(SearchHit {
            path: row.get(0)?,
            snippet: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
pub fn build_for_test(db: &Db, project: &Project) -> Result<i64> {
    build(db, project)
}

#[cfg(test)]
pub fn search_for_test(
    conn: &rusqlite::Connection,
    project_id: &str,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>> {
    search(conn, project_id, query, limit)
}

fn build(db: &Db, project: &Project) -> Result<i64> {
    let root = Path::new(&project.path);
    let files = indexer::collect(root);

    db.tx(|tx| {
        tx.execute(
            "DELETE FROM project_files WHERE project_id = ?1",
            params![project.id],
        )?;

        let mut insert = tx.prepare(
            "INSERT INTO project_files (project_id, path, content) VALUES (?1, ?2, ?3)",
        )?;
        let mut indexed = 0;
        for file in files {
            let Some(content) = indexer::read_text(&file) else {
                continue;
            };
            insert.execute(params![project.id, indexer::relative(root, &file)?, content])?;
            indexed += 1;
        }
        Ok(indexed)
    })
}

fn set_status(db: &Db, project_id: &str, status: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE projects
                SET index_status = ?2,
                    indexed_at = CASE WHEN ?2 = 'indexed' THEN ?3 ELSE indexed_at END,
                    updated_at = ?3
              WHERE id = ?1",
            params![project_id, status, now()],
        )?;
        Ok(())
    })
}
