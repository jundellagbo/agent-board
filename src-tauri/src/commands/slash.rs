use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::projects;
use crate::db::Db;
use crate::error::Result;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// What you type: `/infra-llm-plan`, or `/dir:name` for a nested one.
    pub name: String,
    /// user | project
    pub scope: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
}

/// The slash commands this machine and this project actually have. Agents read
/// them from the same two directories, so this is a listing, not a registry —
/// a command added outside the app shows up without anything to sync.
#[tauri::command]
pub fn list_slash_commands(db: State<Db>, project_id: Option<String>) -> Result<Vec<SlashCommand>> {
    let mut found = Vec::new();

    if let Some(home) = std::env::var_os("HOME") {
        collect(&PathBuf::from(home).join(".claude/commands"), "user", &mut found);
    }
    if let Some(id) = project_id {
        let project = db.with(|conn| projects::get(conn, &id))?;
        collect(
            &PathBuf::from(project.path).join(".claude/commands"),
            "project",
            &mut found,
        );
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.name == b.name);
    Ok(found)
}

fn collect(root: &Path, scope: &str, found: &mut Vec<SlashCommand>) {
    let mut stack = vec![(root.to_path_buf(), String::new())];

    while let Some((dir, prefix)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if path.is_dir() {
                // Nested directories namespace the command, as the CLI does.
                stack.push((path, format!("{prefix}{name}:")));
            } else if let Some(stem) = name.strip_suffix(".md") {
                let (description, argument_hint) = frontmatter(&path);
                found.push(SlashCommand {
                    name: format!("/{prefix}{stem}"),
                    scope: scope.to_string(),
                    description,
                    argument_hint,
                });
            }
        }
    }
}

/// Pulls `description:` and `argument-hint:` out of the leading `---` block.
/// Anything else in there is the CLI's business, not ours.
fn frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let Some(block) = text.strip_prefix("---").and_then(|rest| rest.split("---").next()) else {
        return (None, None);
    };

    let field = |key: &str| {
        block.lines().find_map(|line| {
            line.trim()
                .strip_prefix(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
    };
    (field("description:"), field("argument-hint:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_and_descriptions_from_a_commands_directory() {
        let root = std::env::temp_dir().join(format!("agent-board-slash-{}", crate::db::new_id()));
        std::fs::create_dir_all(root.join("infra")).unwrap();

        std::fs::write(
            root.join("plan.md"),
            "---\ndescription: Plan it out\nargument-hint: <path>\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(root.join("infra/deploy.md"), "no frontmatter here").unwrap();
        std::fs::write(root.join("notes.txt"), "not a command").unwrap();

        let mut found = Vec::new();
        collect(&root, "user", &mut found);
        found.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(
            found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["/infra:deploy", "/plan"],
            "nested commands are namespaced, and non-markdown is skipped"
        );
        assert_eq!(found[1].description.as_deref(), Some("Plan it out"));
        assert_eq!(found[1].argument_hint.as_deref(), Some("<path>"));
        assert_eq!(found[0].description, None, "frontmatter is optional");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_directory_that_is_not_there_is_not_an_error() {
        let mut found = Vec::new();
        collect(Path::new("/nope/not/here"), "user", &mut found);
        assert!(found.is_empty());
    }
}
