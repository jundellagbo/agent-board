use rusqlite::Connection;

use crate::error::Result;

/// Forward-only: append a file and a line here, never edit a shipped migration.
/// The index in this list is the schema version written to `PRAGMA user_version`.
const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../../migrations/0001_init.sql")),
    (
        "0002_project_index",
        include_str!("../../migrations/0002_project_index.sql"),
    ),
    (
        "0003_run_summary",
        include_str!("../../migrations/0003_run_summary.sql"),
    ),
    (
        "0004_agent_model",
        include_str!("../../migrations/0004_agent_model.sql"),
    ),
    (
        "0005_agent_model_backfill",
        include_str!("../../migrations/0005_agent_model_backfill.sql"),
    ),
    (
        "0006_task_model",
        include_str!("../../migrations/0006_task_model.sql"),
    ),
    (
        "0007_project_auto_run",
        include_str!("../../migrations/0007_project_auto_run.sql"),
    ),
    (
        "0008_group_model",
        include_str!("../../migrations/0008_group_model.sql"),
    ),
    (
        "0009_pipeline_columns",
        include_str!("../../migrations/0009_pipeline_columns.sql"),
    ),
    (
        "0010_group_plans",
        include_str!("../../migrations/0010_group_plans.sql"),
    ),
    (
        "0011_settle_routing",
        include_str!("../../migrations/0011_settle_routing.sql"),
    ),
    (
        "0012_task_remote",
        include_str!("../../migrations/0012_task_remote.sql"),
    ),
    (
        "0013_unattended_defaults",
        include_str!("../../migrations/0013_unattended_defaults.sql"),
    ),
    (
        "0014_task_plan",
        include_str!("../../migrations/0014_task_plan.sql"),
    ),
    (
        "0015_agent_tmp_dir",
        include_str!("../../migrations/0015_agent_tmp_dir.sql"),
    ),
    (
        "0016_no_running_lane",
        include_str!("../../migrations/0016_no_running_lane.sql"),
    ),
    (
        "0017_task_worktree",
        include_str!("../../migrations/0017_task_worktree.sql"),
    ),
];

pub fn run(conn: &Connection) -> Result<()> {
    let applied: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for (version, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let version = version as u32 + 1;
        if version <= applied {
            continue;
        }
        log::info!("applying migration {name}");
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        run(&conn).unwrap();

        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as u32);

        // Named, not counted: FTS5 adds shadow tables of its own.
        for table in [
            "organizations",
            "agents",
            "projects",
            "board_groups",
            "tasks",
            "task_runs",
            "mcp_installs",
            "settings",
            "project_files",
        ] {
            let found: u32 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{table} is missing");
        }
    }
}
