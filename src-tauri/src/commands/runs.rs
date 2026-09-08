use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, State};

use crate::commands::{groups, tasks};
use crate::db::{new_id, now, Db};
use crate::error::Result;
use crate::models::{Task, TaskRun};

/// Takes a card out of the queue and into its column's running lane, recording
/// the run. Claiming is a transaction so two runners can't take the same card.
#[tauri::command]
pub fn claim_task(
    app: AppHandle,
    db: State<Db>,
    task_id: String,
    command: String,
    cwd: String,
    agent_id: Option<String>,
) -> Result<TaskRun> {
    let run = db.tx(|tx| claim(tx, &task_id, &command, &cwd, agent_id.as_deref()))?;
    let project_id = db.with(|conn| Ok(tasks::get(conn, &task_id)?.project_id))?;
    crate::board_events::announce(&app, &project_id);
    Ok(run)
}

pub fn claim(
    conn: &Connection,
    task_id: &str,
    command: &str,
    cwd: &str,
    agent_id: Option<&str>,
) -> Result<TaskRun> {
    {
        let tx = conn;
        let task = tasks::get(tx, &task_id)?;
        let group = groups::get(tx, &task.group_id)?;

        let run_id = new_id();
        let ts = now();
        tx.execute(
            "INSERT INTO task_runs (id, task_id, agent_id, group_id, command, cwd, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![run_id, task_id, agent_id, task.group_id, command, cwd, ts],
        )?;
        tx.execute(
            "UPDATE tasks SET run_state = 'running', last_run_id = ?2, updated_at = ?3
             WHERE id = ?1",
            params![task_id, run_id, ts],
        )?;

        if let Some(target) = group.running_group_id {
            move_to(tx, &task, &target)?;
        }
        get_run(tx, &run_id)
    }
}

/// The exit code decides where the card lands — success and failure targets come
/// from the column the run was claimed from, not from wherever the card sits now.
#[tauri::command]
pub fn finish_run(
    app: AppHandle,
    db: State<Db>,
    run_id: String,
    exit_code: i64,
    status: String,
    summary: Option<String>,
) -> Result<Task> {
    let task = db.tx(|tx| finish(tx, &run_id, exit_code, &status, summary.as_deref()))?;
    crate::board_events::announce(&app, &task.project_id);
    Ok(task)
}

pub fn finish(
    conn: &Connection,
    run_id: &str,
    exit_code: i64,
    status: &str,
    summary: Option<&str>,
) -> Result<Task> {
    {
        let tx = conn;
        let run = get_run(tx, &run_id)?;
        let ts = now();
        tx.execute(
            "UPDATE task_runs SET status = ?2, exit_code = ?3, finished_at = ?4, summary = ?5
             WHERE id = ?1",
            params![run_id, status, exit_code, ts, summary],
        )?;

        let task = tasks::get(tx, &run.task_id)?;
        // "Blocked" is the agent saying it could not finish; "failed" is the
        // process going wrong. Both route the same way, but only one of them
        // means a person has something to read.
        let run_state = match (status, exit_code) {
            ("blocked", _) => "blocked",
            (_, 0) => "done",
            _ => "failed",
        };
        tx.execute(
            "UPDATE tasks SET run_state = ?2, updated_at = ?3 WHERE id = ?1",
            params![task.id, run_state, ts],
        )?;

        if let Some(origin) = run.group_id.as_deref() {
            let group = groups::get(tx, origin)?;
            let target = if exit_code == 0 {
                group.success_group_id
            } else {
                group.failure_group_id
            };
            if let Some(target) = target {
                move_to(tx, &task, &target)?;
            }
        }
        tasks::get(tx, &task.id)
    }
}

/// Abandons a run without routing the card anywhere.
///
/// Distinct from finishing: dropping is "forget this attempt", so the card goes
/// back to idle where it already sits and can simply be claimed again. Routing
/// it to the failure column would say the work failed, which it did not — it
/// was never allowed to finish.
#[tauri::command]
pub fn cancel_run(app: AppHandle, db: State<Db>, task_id: String) -> Result<Task> {
    let task = db.tx(|tx| {
        let ts = now();
        tx.execute(
            "UPDATE task_runs SET status = 'killed', exit_code = -1, finished_at = ?2
              WHERE task_id = ?1 AND finished_at IS NULL",
            params![task_id, ts],
        )?;
        tx.execute(
            "UPDATE tasks SET run_state = 'idle', updated_at = ?2 WHERE id = ?1",
            params![task_id, ts],
        )?;
        tasks::get(tx, &task_id)
    })?;

    crate::board_events::announce(&app, &task.project_id);
    Ok(task)
}

/// Closes runs the window can no longer see.
///
/// Sessions live in the window; a reload loses them while the pty keeps going.
/// The frontend kills those ptys and then calls this, so a run never stays open
/// with nothing able to finish it.
#[tauri::command]
pub fn reconcile_runs(app: AppHandle, db: State<Db>) -> Result<usize> {
    let projects = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT project_id FROM tasks
              WHERE run_state IN ('queued', 'planning', 'running', 'needs_approval')",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    })?;

    let closed = db.with(reconcile)?;
    for project_id in projects {
        crate::board_events::announce(&app, &project_id);
    }
    Ok(closed)
}

/// A run cannot outlive the process that owned its pty, so anything still marked
/// running at startup died with the last session. Closing them out is what stops
/// a card sitting in the running lane forever after a crash or a quit mid-run.
pub fn reconcile(conn: &Connection) -> Result<usize> {
    let ts = now();
    let closed = conn.execute(
        "UPDATE task_runs SET status = 'killed', exit_code = -1, finished_at = ?1
          WHERE status = 'running'",
        params![ts],
    )?;
    conn.execute(
        "UPDATE tasks SET run_state = 'idle', updated_at = ?1
          WHERE run_state IN ('queued', 'planning', 'running', 'needs_approval')",
        params![ts],
    )?;
    Ok(closed)
}

#[tauri::command]
pub fn list_runs(db: State<Db>, task_id: String) -> Result<Vec<TaskRun>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {} FROM task_runs WHERE task_id = ?1 ORDER BY started_at DESC",
            TaskRun::COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![task_id], TaskRun::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

fn move_to(conn: &Connection, task: &Task, group_id: &str) -> Result<()> {
    if task.group_id == group_id {
        return Ok(());
    }
    let position: i64 = conn.query_row(
        "SELECT coalesce(max(position), -1) + 1 FROM tasks WHERE group_id = ?1",
        params![group_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE tasks SET group_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
        params![task.id, group_id, position, now()],
    )?;
    conn.execute(
        "UPDATE tasks SET position = position - 1 WHERE group_id = ?1 AND position > ?2",
        params![task.group_id, task.position],
    )?;
    Ok(())
}

fn get_run(conn: &Connection, id: &str) -> Result<TaskRun> {
    let sql = format!("SELECT {} FROM task_runs WHERE id = ?1", TaskRun::COLUMNS);
    conn.query_row(&sql, params![id], TaskRun::from_row)
        .optional()?
        .ok_or_else(|| crate::error::Error::NotFound(format!("run {id}")))
}
