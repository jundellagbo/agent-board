use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Organization {
    pub const COLUMNS: &'static str = "id, name, position, created_at, updated_at";

    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            position: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub path: String,
    pub agent_id: Option<String>,
    pub is_git: bool,
    pub use_worktrees: bool,
    /// Master switch for the runner; a column still needs its own auto_run.
    pub auto_run: bool,
    pub index_status: String,
    pub indexed_at: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Project {
    pub const COLUMNS: &'static str = "id, org_id, name, path, agent_id, is_git, use_worktrees, \
                                       auto_run, index_status, indexed_at, position, created_at, \
                                       updated_at";

    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            org_id: row.get(1)?,
            name: row.get(2)?,
            path: row.get(3)?,
            agent_id: row.get(4)?,
            is_git: row.get(5)?,
            use_worktrees: row.get(6)?,
            auto_run: row.get(7)?,
            index_status: row.get(8)?,
            indexed_at: row.get(9)?,
            position: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardGroup {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// todo | in_progress | review | done | custom
    pub board_type: String,
    pub position: i64,
    pub auto_run: bool,
    /// Cards here get a plan before any work starts.
    pub plans: bool,
    pub skills: Vec<String>,
    pub command: Option<String>,
    pub prompt: Option<String>,
    pub agent_id: Option<String>,
    /// Overrides the agent's model for cards in this column.
    pub model: Option<String>,
    pub running_group_id: Option<String>,
    pub success_group_id: Option<String>,
    pub failure_group_id: Option<String>,
    pub wip_limit: Option<i64>,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl BoardGroup {
    pub const COLUMNS: &'static str =
        "id, project_id, name, board_type, position, auto_run, plans, skills, command, prompt, \
         agent_id, model, running_group_id, success_group_id, failure_group_id, wip_limit, color, \
         created_at, updated_at";

    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        let skills: String = row.get(7)?;
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            board_type: row.get(3)?,
            position: row.get(4)?,
            auto_run: row.get(5)?,
            plans: row.get(6)?,
            // A hand-edited row shouldn't take the board down: bad json reads as no skills.
            skills: serde_json::from_str(&skills).unwrap_or_default(),
            command: row.get(8)?,
            prompt: row.get(9)?,
            agent_id: row.get(10)?,
            model: row.get(11)?,
            running_group_id: row.get(12)?,
            success_group_id: row.get(13)?,
            failure_group_id: row.get(14)?,
            wip_limit: row.get(15)?,
            color: row.get(16)?,
            created_at: row.get(17)?,
            updated_at: row.get(18)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub group_id: String,
    pub title: String,
    pub body: Option<String>,
    /// What the agent said it would do. Never the card's own text: that is the
    /// person's, and a plan is only ever shown beside it.
    pub plan: Option<String>,
    pub position: i64,
    pub agent_id: Option<String>,
    /// Overrides the agent's own model for this card only.
    pub model: Option<String>,
    /// Open this card's session to remote control.
    pub remote: bool,
    pub github_url: Option<String>,
    pub github_kind: Option<String>,
    pub github_number: Option<i64>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// idle | queued | planning | running | needs_approval | blocked | done | failed
    pub run_state: String,
    pub last_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Task {
    pub const COLUMNS: &'static str =
        "id, project_id, group_id, title, body, position, agent_id, model, remote, github_url, \
         github_kind, github_number, branch, worktree_path, run_state, last_run_id, created_at, \
         updated_at, plan";

    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            group_id: row.get(2)?,
            title: row.get(3)?,
            body: row.get(4)?,
            position: row.get(5)?,
            agent_id: row.get(6)?,
            model: row.get(7)?,
            remote: row.get(8)?,
            github_url: row.get(9)?,
            github_kind: row.get(10)?,
            github_number: row.get(11)?,
            branch: row.get(12)?,
            worktree_path: row.get(13)?,
            run_state: row.get(14)?,
            last_run_id: row.get(15)?,
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
            plan: row.get(18)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// Command template. Placeholders: {prompt} {task} {body} {skills} {path} {model}.
    pub command: String,
    pub env: String,
    /// The model this agent runs, substituted into {model}.
    pub model: Option<String>,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Agent {
    pub const COLUMNS: &'static str =
        "id, name, command, env, model, is_default, created_at, updated_at";

    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            command: row.get(2)?,
            env: row.get(3)?,
            model: row.get(4)?,
            is_default: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub agent_id: Option<String>,
    pub group_id: Option<String>,
    pub command: String,
    pub cwd: String,
    /// running | exited | killed | error
    pub status: String,
    pub exit_code: Option<i64>,
    pub log_path: Option<String>,
    /// The tail of what the agent printed, kept for the next column's prompt.
    pub summary: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

impl TaskRun {
    pub const COLUMNS: &'static str = "id, task_id, agent_id, group_id, command, cwd, status, \
                                       exit_code, log_path, summary, started_at, finished_at";

    pub fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            task_id: row.get(1)?,
            agent_id: row.get(2)?,
            group_id: row.get(3)?,
            command: row.get(4)?,
            cwd: row.get(5)?,
            status: row.get(6)?,
            exit_code: row.get(7)?,
            log_path: row.get(8)?,
            summary: row.get(9)?,
            started_at: row.get(10)?,
            finished_at: row.get(11)?,
        })
    }
}
