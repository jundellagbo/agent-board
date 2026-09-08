use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::catalog::{self, CatalogEntry};
use crate::commands::projects;
use crate::db::{new_id, now, Db};
use crate::error::{Error, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    /// Empty for a server that is installed but not one we ship.
    pub key: String,
    pub name: String,
    pub description: String,
    pub docs: String,
    pub server: String,
    /// True when the agent CLI itself reports the server, not just our table —
    /// installs made outside the app must still show as installed.
    pub installed: bool,
}

impl CatalogItem {
    fn from_entry(entry: &'static CatalogEntry, installed: bool) -> Self {
        Self {
            key: entry.key.to_string(),
            name: entry.name.to_string(),
            description: entry.description.to_string(),
            docs: entry.docs.to_string(),
            server: catalog::server_name(entry).to_string(),
            installed,
        }
    }
}

/// Async so Tauri runs it off the main thread: `claude mcp list` health-checks
/// every configured server, which took eight seconds here and froze the window.
#[tauri::command]
pub async fn mcp_catalog(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<CatalogItem>> {
    let cwd = working_dir(&db, project_id.as_deref())?;
    let present = tauri::async_runtime::spawn_blocking(move || installed_servers(&cwd))
        .await
        .unwrap_or_default();

    let mut items: Vec<CatalogItem> = catalog::CATALOG
        .iter()
        .map(|entry| {
            let installed = present.iter().any(|name| name == catalog::server_name(entry));
            CatalogItem::from_entry(entry, installed)
        })
        .collect();

    // Servers installed outside this catalog belong in the list too, or the
    // panel would claim you have nothing it does not happen to ship.
    for server in present {
        if items.iter().any(|item| item.server == server) {
            continue;
        }
        items.push(CatalogItem {
            key: String::new(),
            name: server.clone(),
            description: "Installed outside the catalog.".into(),
            docs: String::new(),
            server,
            installed: true,
        });
    }
    Ok(items)
}

/// Installs a server the catalog does not know about: a name and the command
/// that runs it, exactly as `claude mcp add` takes them.
#[tauri::command]
pub async fn install_custom_mcp(
    db: State<'_, Db>,
    name: String,
    command: String,
    scope: String,
    project_id: Option<String>,
) -> Result<String> {
    let name = crate::commands::orgs::non_empty(name, "server name")?;
    let command = crate::commands::orgs::non_empty(command, "command")?;
    let parts = shell_words::split(&command)
        .map_err(|e| Error::Invalid(format!("could not read that command: {e}")))?;
    if parts.is_empty() {
        return Err(Error::Invalid("the command is empty".into()));
    }

    let cwd = working_dir(&db, project_id.as_deref())?;
    let mut args: Vec<String> = vec![
        "mcp".into(),
        "add".into(),
        "--scope".into(),
        cli_scope(&scope).into(),
        name,
        "--".into(),
    ];
    args.extend(parts);

    tauri::async_runtime::spawn_blocking(move || claude(&cwd, &args))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?
}

#[tauri::command]
pub async fn install_mcp(
    db: State<'_, Db>,
    key: String,
    scope: String,
    project_id: Option<String>,
) -> Result<String> {
    let entry = catalog::find(&key).ok_or_else(|| Error::NotFound(format!("catalog entry {key}")))?;
    let cwd = working_dir(&db, project_id.as_deref())?;

    let mut args: Vec<String> = vec!["mcp".into(), "add".into(), "--scope".into(), cli_scope(&scope).into()];
    args.extend(entry.args.iter().map(|arg| arg.to_string()));
    let output = tauri::async_runtime::spawn_blocking(move || claude(&cwd, &args))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))??;

    db.with(|conn| {
        conn.execute(
            "INSERT INTO mcp_installs (id, catalog_key, kind, scope, project_id, status, installed_at)
             VALUES (?1, ?2, 'mcp', ?3, ?4, 'installed', ?5)
             ON CONFLICT(catalog_key, scope, project_id)
             DO UPDATE SET status = 'installed', installed_at = ?5",
            params![new_id(), key, scope, project_id, now()],
        )?;
        Ok(())
    })?;

    Ok(output)
}

#[tauri::command]
pub async fn uninstall_mcp(
    db: State<'_, Db>,
    server: String,
    scope: String,
    project_id: Option<String>,
) -> Result<String> {
    let server = crate::commands::orgs::non_empty(server, "server name")?;
    let cwd = working_dir(&db, project_id.as_deref())?;

    let args: Vec<String> = vec![
        "mcp".into(),
        "remove".into(),
        "--scope".into(),
        cli_scope(&scope).into(),
        server.clone(),
    ];
    let output = tauri::async_runtime::spawn_blocking(move || claude(&cwd, &args))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))??;

    db.with(|conn| {
        conn.execute(
            "DELETE FROM mcp_installs WHERE catalog_key = ?1 AND scope = ?2 AND project_id IS ?3",
            params![server, scope, project_id],
        )?;
        Ok(())
    })?;

    Ok(output)
}

/// A project-scoped install writes into that project's config, so it has to run
/// there; a user-scoped one is global and runs from home.
fn working_dir(db: &Db, project_id: Option<&str>) -> Result<PathBuf> {
    if let Some(id) = project_id {
        let project = db.with(|conn| projects::get(conn, id))?;
        return Ok(PathBuf::from(project.path));
    }
    Ok(std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir()))
}

fn cli_scope(scope: &str) -> &'static str {
    if scope == "project" {
        "project"
    } else {
        "user"
    }
}

fn installed_servers(cwd: &Path) -> Vec<String> {
    let mut command = Command::new("claude");
    command.args(["mcp", "list"]).current_dir(cwd);

    match crate::process::run(command, Duration::from_secs(20)) {
        Ok(output) if output.ok => parse_server_list(&output.stdout),
        // An unreachable server or a missing CLI means "nothing known
        // installed", not a broken settings screen.
        _ => Vec::new(),
    }
}

/// `claude mcp list` prints "name: command - status", after a health-check
/// header. Names with spaces are the CLI's own connectors, not catalog servers.
fn parse_server_list(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(name, _)| name.trim().to_string())
        .filter(|name| !name.is_empty() && !name.contains(' '))
        .collect()
}

fn claude(cwd: &Path, args: &[String]) -> Result<String> {
    let mut command = Command::new("claude");
    command.args(args).current_dir(cwd);

    let output = crate::process::run(command, Duration::from_secs(60))?;
    if !output.ok {
        return Err(Error::Invalid(if output.stderr.is_empty() {
            output.stdout
        } else {
            output.stderr
        }));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::parse_server_list;

    #[test]
    fn reads_the_server_names_out_of_a_health_check() {
        let stdout = "Checking MCP server health…\n\n\
             chrome-devtools: npx chrome-devtools-mcp - \u{2714} Connected\n\
             claude.ai Figma: https://mcp.figma.com/mcp - \u{2714} Connected\n\
             playwright: npx @playwright/mcp - \u{2718} Failed to connect\n";

        let names = parse_server_list(stdout);
        assert_eq!(names, ["chrome-devtools", "playwright"]);
    }
}
