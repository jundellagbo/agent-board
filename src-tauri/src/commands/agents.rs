use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::State;

use crate::commands::orgs::non_empty;
use crate::db::{new_id, now, Db};
use crate::error::{Error, Result};
use crate::models::Agent;

/// Seeded once, on an empty table. They are ordinary rows afterwards — editable
/// and deletable — so this is a starting point, not a hard-coded list.
///
/// The model is only pre-filled where we can name a current one with confidence.
/// A blank model drops the `--model` flag rather than passing an empty value.
const BUILT_INS: &[(&str, &str, Option<&str>, bool)] = &[
    // `--permission-mode auto` is the CLI's own auto mode: it keeps a card from
    // stalling on a confirmation nobody is sitting there to answer. `--add-dir`
    // reaches the card's scratch store, which sits outside the worktree the CLI
    // would otherwise confine itself to; it drops out for a card with no files.
    (
        "Claude Code",
        "claude --permission-mode auto --model {model} --add-dir {tmp} {prompt}",
        Some("claude-opus-5"),
        true,
    ),
    (
        "Claude Code (print)",
        "claude -p --permission-mode auto --model {model} --add-dir {tmp} {prompt}",
        Some("claude-opus-5"),
        false,
    ),
    ("Codex", "codex {prompt}", None, false),
    ("Aider", "aider --model {model} --message {prompt}", None, false),
    ("Shell", "", None, false),
];

pub fn seed_built_ins(conn: &Connection) -> Result<()> {
    let existing: i64 = conn.query_row("SELECT count(*) FROM agents", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(());
    }
    let ts = now();
    for (name, command, model, is_default) in BUILT_INS {
        conn.execute(
            "INSERT INTO agents (id, name, command, model, is_default, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![new_id(), name, command, model, is_default, ts],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_agents(db: State<Db>) -> Result<Vec<Agent>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {} FROM agents ORDER BY is_default DESC, name",
            Agent::COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], Agent::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatch {
    pub name: Option<String>,
    pub command: Option<String>,
    pub env: Option<String>,
    pub model: Option<String>,
    pub is_default: Option<bool>,
}

#[tauri::command]
pub fn save_agent(db: State<Db>, id: Option<String>, patch: AgentPatch) -> Result<Agent> {
    db.tx(|tx| {
        let id = match id {
            Some(id) => {
                let current = get(tx, &id)?;
                tx.execute(
                    "UPDATE agents SET name = ?2, command = ?3, env = ?4, model = ?5,
                                       updated_at = ?6
                     WHERE id = ?1",
                    params![
                        id,
                        match &patch.name {
                            Some(name) => non_empty(name.clone(), "agent name")?,
                            None => current.name,
                        },
                        patch.command.clone().unwrap_or(current.command),
                        patch.env.clone().unwrap_or(current.env),
                        patch
                            .model
                            .clone()
                            .map(|model| model.trim().to_string())
                            .filter(|model| !model.is_empty())
                            .or(current.model),
                        now()
                    ],
                )?;
                id
            }
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO agents (id, name, command, env, model, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![
                        id,
                        non_empty(patch.name.clone().unwrap_or_default(), "agent name")?,
                        patch.command.clone().unwrap_or_default(),
                        patch.env.clone().unwrap_or_else(|| "{}".into()),
                        patch
                            .model
                            .clone()
                            .map(|model| model.trim().to_string())
                            .filter(|model| !model.is_empty()),
                        now()
                    ],
                )?;
                id
            }
        };

        // Exactly one default, always: promoting one demotes the rest.
        if patch.is_default == Some(true) {
            tx.execute("UPDATE agents SET is_default = (id = ?1)", params![id])?;
        }
        get(tx, &id)
    })
}

#[tauri::command]
pub fn delete_agent(db: State<Db>, id: String) -> Result<()> {
    db.tx(|tx| {
        let agent = get(tx, &id)?;
        tx.execute("DELETE FROM agents WHERE id = ?1", params![id])?;

        // Never leave the board without a default to fall back on.
        if agent.is_default {
            tx.execute(
                "UPDATE agents SET is_default = 1
                  WHERE id = (SELECT id FROM agents ORDER BY name LIMIT 1)",
                [],
            )?;
        }
        Ok(())
    })
}

fn get(conn: &Connection, id: &str) -> Result<Agent> {
    let sql = format!("SELECT {} FROM agents WHERE id = ?1", Agent::COLUMNS);
    conn.query_row(&sql, params![id], Agent::from_row)
        .map_err(|_| Error::NotFound(format!("agent {id}")))
}
