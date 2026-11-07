use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    /// `name@marketplace`, which is what install and uninstall take.
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub installed: bool,
    pub enabled: bool,
}

/// Everything the agent CLI knows about: what is installed, and what the
/// marketplaces offer. Both come from one call, and the marketplace half is the
/// slow part — hence the generous deadline.
#[tauri::command]
pub async fn list_plugins() -> Result<Vec<Plugin>> {
    tauri::async_runtime::spawn_blocking(read_plugins)
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?
}

fn read_plugins() -> Result<Vec<Plugin>> {
    let mut command = crate::platform::command("claude");
    command.args(["plugin", "list", "--json", "--available"]);
    command.current_dir(home());

    let output = crate::process::run(command, Duration::from_secs(120))?;
    if !output.ok {
        return Err(Error::Invalid(if output.stderr.is_empty() {
            "the agent CLI could not list plugins".into()
        } else {
            output.stderr
        }));
    }

    parse_plugins(&output.stdout)
}

fn parse_plugins(json: &str) -> Result<Vec<Plugin>> {
    let parsed: Value = serde_json::from_str(json)
        .map_err(|e| Error::Invalid(format!("could not read the plugin list: {e}")))?;

    let mut plugins: Vec<Plugin> = Vec::new();
    let mut push = |value: &Value, installed: bool| {
        let id = value
            .get("id")
            .or_else(|| value.get("pluginId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            return;
        }

        // An installed entry carries no description, so the name falls back to
        // the part of the id before the marketplace.
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| id.split('@').next().unwrap_or(&id).to_string());

        plugins.push(Plugin {
            id,
            name,
            description: value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            version: value.get("version").and_then(Value::as_str).map(str::to_string),
            installed,
            enabled: value.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        });
    };

    for value in parsed.get("installed").and_then(Value::as_array).into_iter().flatten() {
        push(value, true);
    }
    for value in parsed.get("available").and_then(Value::as_array).into_iter().flatten() {
        push(value, false);
    }

    // An available entry describes a plugin the installed entry only names, so
    // the two are folded together rather than listed twice.
    let mut merged: Vec<Plugin> = Vec::new();
    for plugin in plugins {
        match merged.iter_mut().find(|existing| existing.id == plugin.id) {
            Some(existing) => {
                if existing.description.is_empty() {
                    existing.description = plugin.description;
                }
                if existing.name.is_empty() {
                    existing.name = plugin.name;
                }
            }
            None => merged.push(plugin),
        }
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the CLI actually returns: installed entries carry a version and
    /// an enabled flag but no description, available ones the reverse.
    const LISTING: &str = r#"{
      "installed": [
        {"id": "impeccable@impeccable", "version": "4.0.1", "scope": "user", "enabled": true},
        {"id": "figma@claude-plugins-official", "version": "2.2.107", "enabled": false}
      ],
      "available": [
        {"pluginId": "impeccable@impeccable", "name": "impeccable", "description": "Design review"},
        {"pluginId": "other@market", "name": "other", "description": "Something else"}
      ]
    }"#;

    #[test]
    fn installed_and_available_are_one_list() {
        let plugins = parse_plugins(LISTING).unwrap();

        assert_eq!(plugins.len(), 3, "the two halves fold together, not stack up");

        let impeccable = plugins.iter().find(|p| p.id == "impeccable@impeccable").unwrap();
        assert!(impeccable.installed && impeccable.enabled);
        assert_eq!(impeccable.version.as_deref(), Some("4.0.1"));
        assert_eq!(
            impeccable.description, "Design review",
            "the description only the marketplace half carries"
        );

        let figma = plugins.iter().find(|p| p.id.starts_with("figma")).unwrap();
        assert!(figma.installed && !figma.enabled);
        assert_eq!(figma.name, "figma", "a name falls back to the id before the marketplace");

        let other = plugins.iter().find(|p| p.id == "other@market").unwrap();
        assert!(!other.installed);
    }

    #[test]
    fn a_listing_without_the_pieces_we_want_is_empty_not_an_error() {
        assert!(parse_plugins("{}").unwrap().is_empty());
        assert!(parse_plugins(r#"{"installed": [{"version": "1"}]}"#).unwrap().is_empty());
        assert!(parse_plugins("not json").is_err());
    }
}

#[tauri::command]
pub async fn install_plugin(id: String) -> Result<String> {
    plugin_command("install", id).await
}

#[tauri::command]
pub async fn uninstall_plugin(id: String) -> Result<String> {
    plugin_command("uninstall", id).await
}

async fn plugin_command(action: &'static str, id: String) -> Result<String> {
    let id = crate::commands::orgs::non_empty(id, "plugin")?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut command = crate::platform::command("claude");
        command.args(["plugin", action, &id]).current_dir(home());

        let output = crate::process::run(command, Duration::from_secs(180))?;
        if !output.ok {
            return Err(Error::Invalid(if output.stderr.is_empty() {
                output.stdout
            } else {
                output.stderr
            }));
        }
        Ok(output.stdout)
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?
}

fn home() -> PathBuf {
    crate::platform::home_or_temp()
}
