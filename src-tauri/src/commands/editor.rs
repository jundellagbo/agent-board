use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    /// The executable, which is also how the frontend asks for this one.
    pub command: String,
    pub name: String,
}

/// Graphical editors worth opening a worktree in, best first. VS Code leads
/// because it is the one most people mean; the rest are here so a machine
/// without it is not stuck.
const EDITORS: &[(&str, &str)] = &[
    ("code", "VS Code"),
    ("code-insiders", "VS Code Insiders"),
    ("cursor", "Cursor"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
    ("subl", "Sublime Text"),
    ("webstorm", "WebStorm"),
    ("idea", "IntelliJ IDEA"),
];

/// The editors on this machine, in the order they should be offered.
pub fn available(on_path: impl Fn(&str) -> bool) -> Vec<Editor> {
    EDITORS
        .iter()
        .filter(|(command, _)| on_path(command))
        .map(|(command, name)| Editor {
            command: command.to_string(),
            name: name.to_string(),
        })
        .collect()
}

#[tauri::command]
pub fn list_editors() -> Vec<Editor> {
    available(|command| which(command).is_some())
}

/// Opens a directory in an editor and leaves it running on its own.
#[tauri::command]
pub fn open_in_editor(path: String, command: Option<String>) -> Result<String> {
    let directory = PathBuf::from(&path);
    if !directory.exists() {
        return Err(Error::Invalid(format!("{path} is not there any more")));
    }

    let editors = list_editors();
    let chosen = match command {
        Some(wanted) => editors
            .into_iter()
            .find(|editor| editor.command == wanted)
            .ok_or_else(|| Error::Invalid(format!("{wanted} is not on this machine")))?,
        None => editors
            .into_iter()
            .next()
            .ok_or_else(|| Error::Invalid("no editor found on this machine".into()))?,
    };

    // Detached: the editor outlives this app, and its output is not ours.
    Command::new(&chosen.command)
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::Invalid(format!("could not start {}: {e}", chosen.name)))?;

    Ok(chosen.name)
}

/// Finds an executable on PATH without shelling out to `which`, which does not
/// exist everywhere this app runs.
pub fn which(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };

    std::env::split_paths(&path).find_map(|directory| {
        extensions.iter().find_map(|extension| {
            let candidate = directory.join(format!("{command}{extension}"));
            is_executable(&candidate).then_some(candidate)
        })
    })
}

fn is_executable(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editors_are_offered_best_first() {
        let everything = available(|_| true);
        assert_eq!(
            everything.first().map(|editor| editor.name.as_str()),
            Some("VS Code"),
            "the one most people mean comes first"
        );

        let only_zed = available(|command| command == "zed");
        assert_eq!(only_zed.len(), 1);
        assert_eq!(only_zed[0].name, "Zed");

        assert!(available(|_| false).is_empty(), "a machine with none offers none");
    }

    #[test]
    #[cfg(unix)]
    fn the_path_search_finds_a_real_program() {
        // `sh` is on every machine this builds for.
        assert!(which("sh").is_some());
        assert!(which("definitely-not-a-program-9f3a").is_none());
    }
}
