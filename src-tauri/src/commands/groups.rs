use rusqlite::{params, Connection};
use serde::{Deserialize, Deserializer};
use tauri::State;

use crate::commands::orgs::non_empty;
use crate::db::{new_id, now, Db};
use crate::error::{Error, Result};
use crate::models::BoardGroup;

/// The board every project starts with: work, a human look, an agent review,
/// done. Committing is left to a person, which is why no column does it. Routing
/// lives in the data, which is what lets the runner stay generic.
struct Seed {
    name: &'static str,
    board_type: &'static str,
    auto_run: bool,
    plans: bool,
    /// Where a card sits while its agent runs. `None` leaves it in place, which
    /// reads better for the review column than shunting every card back to In
    /// Progress.
    running: Option<usize>,
    success: Option<usize>,
    failure: Option<usize>,
    /// The column's standing instruction, prepended to every card's prompt.
    prompt: Option<&'static str>,
    /// Overrides the agent's model, for a column whose work does not need the
    /// expensive one.
    model: Option<&'static str>,
}

const FOR_REVIEW: usize = 1;

const DEFAULTS: &[Seed] = &[
    Seed {
        name: "Todo",
        board_type: "todo",
        auto_run: true,
        plans: true,
        // No running lane: a card being worked on says so on its own face, and a
        // column that only ever holds the one card in flight earned its keep by
        // repeating what the badge already says.
        running: None,
        success: Some(FOR_REVIEW),
        failure: None,
        prompt: None,
        model: None,
    },
    Seed {
        name: "For Review",
        board_type: "review",
        auto_run: false,
        plans: false,
        running: None,
        success: None,
        failure: None,
        prompt: None,
        model: None,
    },
    // Nothing routes into this column automatically; a person promotes a card
    // here from For Review, which is the point of having both.
    Seed {
        name: "Agent Review",
        board_type: "custom",
        auto_run: true,
        plans: false,
        running: None,
        success: None,
        failure: None,
        prompt: Some(
            "Review the change on this branch. Read the diff, check it does what the card \
             asked, and look for correctness bugs, missing edge cases and anything left \
             half-done. Fix what is plainly wrong; leave judgement calls to a person and say \
             what you left. Do not add features the card did not ask for.",
        ),
        model: None,
    },
    Seed {
        name: "Completed",
        board_type: "done",
        auto_run: false,
        plans: false,
        running: None,
        success: None,
        failure: None,
        prompt: None,
        model: None,
    },
];

pub fn seed_defaults(conn: &Connection, project_id: &str) -> Result<()> {
    let ts = now();
    let ids: Vec<String> = DEFAULTS.iter().map(|_| new_id()).collect();

    for (position, (seed, id)) in DEFAULTS.iter().zip(&ids).enumerate() {
        conn.execute(
            "INSERT INTO board_groups (id, project_id, name, board_type, position, auto_run,
                                       plans, prompt, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                project_id,
                seed.name,
                seed.board_type,
                position as i64,
                seed.auto_run,
                seed.plans,
                seed.prompt,
                seed.model,
                ts
            ],
        )?;
    }

    // Routing is a second pass because every column has to exist to be pointed at.
    for (seed, id) in DEFAULTS.iter().zip(&ids) {
        conn.execute(
            "UPDATE board_groups
                SET running_group_id = ?2, success_group_id = ?3, failure_group_id = ?4
              WHERE id = ?1",
            params![
                id,
                seed.running.map(|index| ids[index].clone()),
                seed.success.map(|index| ids[index].clone()),
                seed.failure.map(|index| ids[index].clone()),
            ],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_groups(db: State<Db>, project_id: String) -> Result<Vec<BoardGroup>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {} FROM board_groups WHERE project_id = ?1 ORDER BY position, created_at",
            BoardGroup::COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![project_id], BoardGroup::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPatch {
    pub name: Option<String>,
    pub board_type: Option<String>,
    pub auto_run: Option<bool>,
    pub plans: Option<bool>,
    pub skills: Option<Vec<String>>,
    pub command: Option<String>,
    pub prompt: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub running_group_id: Option<String>,
    pub success_group_id: Option<String>,
    pub failure_group_id: Option<String>,
    /// Nested option so a sent `null` clears the limit while an omitted field
    /// leaves it alone — a plain Option can't tell those two apart.
    #[serde(default, deserialize_with = "double_option")]
    pub wip_limit: Option<Option<i64>>,
    pub color: Option<String>,
}

#[tauri::command]
pub fn create_group(db: State<Db>, project_id: String, patch: GroupPatch) -> Result<BoardGroup> {
    let name = non_empty(patch.name.clone().unwrap_or_default(), "group name")?;
    let board_type = patch.board_type.clone().unwrap_or_else(|| "custom".into());

    db.with(|conn| {
        let position: i64 = conn.query_row(
            "SELECT coalesce(max(position), -1) + 1 FROM board_groups WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        let id = new_id();
        let ts = now();
        conn.execute(
            "INSERT INTO board_groups (id, project_id, name, board_type, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, project_id, name, board_type, position, ts],
        )?;
        apply_patch(conn, &id, &patch)?;
        get(conn, &id)
    })
}

#[tauri::command]
pub fn update_group(db: State<Db>, id: String, patch: GroupPatch) -> Result<BoardGroup> {
    db.with(|conn| {
        get(conn, &id)?;
        apply_patch(conn, &id, &patch)?;
        get(conn, &id)
    })
}

/// Refuses to strand cards: the group must be empty, or its tasks move first.
#[tauri::command]
pub fn delete_group(db: State<Db>, id: String, move_tasks_to: Option<String>) -> Result<()> {
    db.tx(|tx| {
        let tasks: i64 = tx.query_row(
            "SELECT count(*) FROM tasks WHERE group_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if tasks > 0 {
            let target = move_tasks_to
                .ok_or_else(|| Error::Invalid(format!("{tasks} card(s) still in this group")))?;
            tx.execute(
                "UPDATE tasks
                    SET group_id = ?2,
                        position = position
                                 + (SELECT coalesce(max(position), -1) + 1 FROM tasks WHERE group_id = ?2),
                        updated_at = ?3
                  WHERE group_id = ?1",
                params![id, target, now()],
            )?;
        }
        tx.execute("DELETE FROM board_groups WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_groups(db: State<Db>, ids: Vec<String>) -> Result<()> {
    db.tx(|tx| {
        let ts = now();
        for (position, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE board_groups SET position = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, position as i64, ts],
            )?;
        }
        Ok(())
    })
}

/// Only the fields present in the patch are written, so a partial update from
/// the UI can never blank out a column it didn't render.
fn apply_patch(conn: &Connection, id: &str, patch: &GroupPatch) -> Result<()> {
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    let mut set = |column: &str, value: rusqlite::types::Value| {
        values.push(value);
        sets.push(format!("{column} = ?{}", values.len()));
    };

    if let Some(v) = &patch.name {
        set("name", v.trim().to_string().into());
    }
    if let Some(v) = &patch.board_type {
        set("board_type", v.clone().into());
    }
    if let Some(v) = patch.auto_run {
        set("auto_run", v.into());
    }
    if let Some(v) = patch.plans {
        set("plans", v.into());
    }
    if let Some(v) = &patch.skills {
        set("skills", serde_json::to_string(v)?.into());
    }
    if let Some(v) = &patch.command {
        set("command", empty_to_null(v));
    }
    if let Some(v) = &patch.prompt {
        set("prompt", empty_to_null(v));
    }
    if let Some(v) = &patch.agent_id {
        set("agent_id", empty_to_null(v));
    }
    if let Some(v) = &patch.model {
        set("model", empty_to_null(v));
    }
    if let Some(v) = &patch.running_group_id {
        set("running_group_id", empty_to_null(v));
    }
    if let Some(v) = &patch.success_group_id {
        set("success_group_id", empty_to_null(v));
    }
    if let Some(v) = &patch.failure_group_id {
        set("failure_group_id", empty_to_null(v));
    }
    if let Some(v) = patch.wip_limit {
        set(
            "wip_limit",
            v.map_or(rusqlite::types::Value::Null, Into::into),
        );
    }
    if let Some(v) = &patch.color {
        set("color", empty_to_null(v));
    }

    if sets.is_empty() {
        return Ok(());
    }

    values.push(now().into());
    sets.push(format!("updated_at = ?{}", values.len()));
    values.push(id.to_string().into());

    let sql = format!(
        "UPDATE board_groups SET {} WHERE id = ?{}",
        sets.join(", "),
        values.len()
    );
    conn.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(())
}

fn double_option<'de, T, D>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

fn empty_to_null(value: &str) -> rusqlite::types::Value {
    match value.trim() {
        "" => rusqlite::types::Value::Null,
        other => other.to_string().into(),
    }
}

pub fn get(conn: &Connection, id: &str) -> Result<BoardGroup> {
    let sql = format!("SELECT {} FROM board_groups WHERE id = ?1", BoardGroup::COLUMNS);
    conn.query_row(&sql, params![id], BoardGroup::from_row)
        .map_err(|_| Error::NotFound(format!("board group {id}")))
}
