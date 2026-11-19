use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{Error, Result};

/// Planning notes live in the tmp store rather than any repo, so their paths can
/// be handed to an agent as a reference without ever showing up in `git status`.
const DIR: &str = "planner";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: String,
}

pub fn root(app: &AppHandle) -> Result<PathBuf> {
    Ok(super::tmp::root(app)?.join(DIR))
}

/// A bare `.md` file name: no directories, no traversal, and the extension is
/// added when missing so every note opens as markdown elsewhere too.
fn note_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    let usable = !trimmed.is_empty()
        && !trimmed.starts_with('.')
        && !trimmed.contains(['/', '\\', ':'])
        && trimmed != "..";
    if !usable {
        return Err(Error::Invalid(format!("{name} is not a file name")));
    }
    Ok(if trimmed.to_ascii_lowercase().ends_with(".md") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    })
}

fn describe(path: &Path) -> Option<PlanFile> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    Some(PlanFile {
        name: path.file_name()?.to_str()?.to_string(),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        modified_at: chrono::DateTime::<chrono::Utc>::from(modified)
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    })
}

fn existing(root: &Path, name: &str) -> Result<PathBuf> {
    let path = root.join(note_name(name)?);
    if !path.is_file() {
        return Err(Error::Invalid(format!("{name} does not exist")));
    }
    Ok(path)
}

pub fn list(root: &Path) -> Result<Vec<PlanFile>> {
    fs::create_dir_all(root)?;
    let mut files: Vec<PlanFile> = fs::read_dir(root)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")))
        .filter_map(|path| describe(&path))
        .collect();
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

/// Creates a note, numbering the name rather than overwriting one already there.
pub fn create(root: &Path, name: &str, contents: &str) -> Result<PlanFile> {
    fs::create_dir_all(root)?;
    let name = note_name(name)?;
    let stem = name.strip_suffix(".md").unwrap_or(&name);
    let path = std::iter::once(root.join(&name))
        .chain((2..).map(|n| root.join(format!("{stem}-{n}.md"))))
        .find(|path| !path.exists())
        .expect("an unused name exists");
    fs::write(&path, contents)?;
    describe(&path).ok_or_else(|| Error::Invalid(format!("could not write {name}")))
}

pub fn read(root: &Path, name: &str) -> Result<String> {
    Ok(fs::read_to_string(existing(root, name)?)?)
}

pub fn write(root: &Path, name: &str, contents: &str) -> Result<PlanFile> {
    let path = existing(root, name)?;
    fs::write(&path, contents)?;
    describe(&path).ok_or_else(|| Error::Invalid(format!("could not write {name}")))
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<PlanFile> {
    let source = existing(root, from)?;
    let target = root.join(note_name(to)?);
    if target != source && target.exists() {
        return Err(Error::Invalid(format!("{to} already exists")));
    }
    fs::rename(&source, &target)?;
    describe(&target).ok_or_else(|| Error::Invalid(format!("could not rename {from}")))
}

pub fn delete(root: &Path, name: &str) -> Result<()> {
    fs::remove_file(existing(root, name)?)?;
    Ok(())
}

#[tauri::command]
pub fn list_plans(app: AppHandle) -> Result<Vec<PlanFile>> {
    list(&root(&app)?)
}

#[tauri::command]
pub fn create_plan(app: AppHandle, name: String, contents: Option<String>) -> Result<PlanFile> {
    create(&root(&app)?, &name, contents.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn read_plan(app: AppHandle, name: String) -> Result<String> {
    read(&root(&app)?, &name)
}

#[tauri::command]
pub fn write_plan(app: AppHandle, name: String, contents: String) -> Result<PlanFile> {
    write(&root(&app)?, &name, &contents)
}

#[tauri::command]
pub fn rename_plan(app: AppHandle, from: String, to: String) -> Result<PlanFile> {
    rename(&root(&app)?, &from, &to)
}

#[tauri::command]
pub fn delete_plan(app: AppHandle, name: String) -> Result<()> {
    delete(&root(&app)?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("agent-board-planner-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn notes_round_trip_and_never_overwrite() {
        let root = scratch("roundtrip");
        let first = create(&root, "plan", "# one").unwrap();
        let second = create(&root, "plan.md", "# two").unwrap();
        assert_eq!(first.name, "plan.md");
        assert_eq!(second.name, "plan-2.md");

        write(&root, "plan.md", "# edited").unwrap();
        assert_eq!(read(&root, "plan.md").unwrap(), "# edited");

        assert!(rename(&root, "plan-2.md", "plan").is_err(), "rename refuses to clobber");
        let renamed = rename(&root, "plan-2.md", "next").unwrap();
        assert_eq!(renamed.name, "next.md");

        delete(&root, "plan.md").unwrap();
        let names: Vec<String> = list(&root).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["next.md"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn names_cannot_leave_the_store() {
        let root = scratch("escape");
        for bad in ["../x", "a/b", "a\\b", "..", "", ".hidden", "c:x"] {
            assert!(create(&root, bad, "").is_err(), "{bad} was accepted");
        }
        assert!(read(&root, "missing").is_err());
        fs::remove_dir_all(&root).ok();
    }
}
