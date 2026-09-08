use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// Claude Code asks before it will work in a directory, and that prompt stops an
/// unattended run dead. A directory the person deliberately added as a project —
/// or a worktree this app made inside it — is already a directory they trust, so
/// the answer is recorded for them.
///
/// Only ever sets this one key, only for the given path, and leaves every other
/// setting in the file untouched.
pub fn trust(path: &Path) -> Result<bool> {
    trust_all(std::slice::from_ref(&path.to_path_buf()))
}

/// One read and at most one write, however many paths are given.
pub fn trust_all(paths: &[PathBuf]) -> Result<bool> {
    match config_path() {
        Some(config) => trust_all_in(&config, paths),
        None => Ok(false),
    }
}

fn config_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude.json"))
}

#[cfg(test)]
pub fn trust_in(config: &Path, path: &Path) -> Result<bool> {
    trust_all_in(config, std::slice::from_ref(&path.to_path_buf()))
}

pub fn trust_all_in(config: &Path, paths: &[PathBuf]) -> Result<bool> {
    // No config means the CLI has never run here; writing one from scratch would
    // be guessing at a format we only partly know.
    if !config.exists() {
        return Ok(false);
    }

    let text = std::fs::read_to_string(config)?;
    let mut root: Value = serde_json::from_str(&text)
        .map_err(|e| Error::Invalid(format!("could not read {}: {e}", config.display())))?;

    let object = root
        .as_object_mut()
        .ok_or_else(|| Error::Invalid("the agent CLI config is not an object".into()))?;
    let projects = object
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| Error::Invalid("the agent CLI config has no project map".into()))?;

    let mut changed = false;
    for path in paths {
        let entry = projects
            .entry(path.to_string_lossy().to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| Error::Invalid("that project's config is not an object".into()))?;

        if entry.get("hasTrustDialogAccepted") != Some(&Value::Bool(true)) {
            entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
            changed = true;
        }
    }

    if !changed {
        return Ok(false);
    }

    // Write beside the file and rename, so an interrupted write cannot leave
    // someone without their agent configuration.
    let temporary = config.with_extension("json.agent-board");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&root)?)?;
    std::fs::rename(&temporary, config)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, json: &str) {
        std::fs::write(path, json).unwrap();
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn records_trust_without_disturbing_anything_else() {
        let dir = std::env::temp_dir().join(format!("agent-board-trust-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join(".claude.json");

        write(
            &config,
            r#"{"autoUpdates": true,
                "projects": {
                  "/other": {"hasTrustDialogAccepted": false, "history": [1, 2]}
                }}"#,
        );

        assert!(trust_in(&config, Path::new("/work/app")).unwrap());

        let after = read(&config);
        assert_eq!(after["projects"]["/work/app"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["autoUpdates"], true, "unrelated settings are kept");
        assert_eq!(
            after["projects"]["/other"]["hasTrustDialogAccepted"],
            false,
            "another project's answer is not ours to change"
        );
        assert_eq!(after["projects"]["/other"]["history"], serde_json::json!([1, 2]));

        assert!(
            !trust_in(&config, Path::new("/work/app")).unwrap(),
            "already trusted, so nothing is rewritten"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_config_is_left_alone() {
        let missing = std::env::temp_dir().join("agent-board-no-such-claude.json");
        std::fs::remove_file(&missing).ok();

        assert!(!trust_in(&missing, Path::new("/work/app")).unwrap());
        assert!(!missing.exists(), "we do not invent an agent configuration");
    }
}
