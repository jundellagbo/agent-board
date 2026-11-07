//! The few things that differ between Linux, macOS and Windows, kept in one place
//! so the rest of the app never has to ask which one it is on.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// The user's home: `HOME` on Unix, `USERPROFILE` on Windows.
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

pub fn home_or_temp() -> PathBuf {
    home().unwrap_or_else(std::env::temp_dir)
}

/// A command for a program found on PATH. On Windows the CLIs this app drives
/// (`claude`, `gh`, `npx`) are often `.cmd` shims, which `Command::new` will not
/// find by bare name, so the full path is resolved first.
pub fn command(program: &str) -> Command {
    Command::new(resolve(program))
}

pub fn resolve(program: &str) -> PathBuf {
    crate::commands::editor::which(program).unwrap_or_else(|| PathBuf::from(program))
}

/// Gives the app the PATH a terminal would have.
///
/// Launched from the Dock, Finder or a desktop menu, a GUI app gets the
/// system's bare PATH, without the directories a login shell adds — so
/// `claude`, `git`, `gh` and `tmux` installed through Homebrew, npm or a
/// version manager are all "not found". The login shell is asked once at start
/// and its PATH merged in front. Windows GUI apps already get the full PATH.
pub fn inherit_login_path() {
    if cfg!(windows) {
        return;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" }.into()
    });
    let mut command = Command::new(shell);
    command.args(["-ilc", "printf '__PATH__%s__PATH__' \"$PATH\""]);
    let Ok(output) = crate::process::run(command, Duration::from_secs(5)) else {
        return;
    };
    let Some(login) = output
        .stdout
        .split("__PATH__")
        .nth(1)
        .filter(|path| !path.is_empty())
    else {
        return;
    };

    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut merged: Vec<PathBuf> = std::env::split_paths(login).collect();
    for entry in std::env::split_paths(&current) {
        if !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    if let Ok(path) = std::env::join_paths(merged) {
        std::env::set_var("PATH", path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn there_is_always_somewhere_to_call_home() {
        assert!(home().is_some());
    }

    #[test]
    fn an_unknown_program_resolves_to_its_own_name() {
        assert_eq!(resolve("definitely-not-a-program-9f3a"), PathBuf::from("definitely-not-a-program-9f3a"));
    }
}
