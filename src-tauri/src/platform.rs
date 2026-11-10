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
    let mut command = Command::new(resolve(program));
    hide_console(&mut command);
    command
}

/// A GUI app has no console, so Windows gives every console program it starts a
/// window of its own — a black flash for each `git` or `claude` call — unless
/// told not to. A program that wants a console (`cmd /c start`) still opens one.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_: &mut Command) {}

/// The file names `program` may have on PATH. On Windows PATHEXT says which
/// (`claude.cmd`, `git.exe`); elsewhere the name is the whole name.
///
/// The bare name is never a Windows candidate: npm installs an extensionless
/// sh script beside every `.cmd` shim (`claude` next to `claude.cmd`), and
/// starting it fails with "not a valid Win32 application".
pub fn executable_names(program: &str) -> Vec<String> {
    if !cfg!(windows) || std::path::Path::new(program).extension().is_some() {
        return vec![program.to_string()];
    }
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    extensions
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(|extension| format!("{program}{}", extension.to_lowercase()))
        .collect()
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

    /// Node ships `npm` as an sh script beside `npm.cmd`, the same layout npm
    /// gives `claude`, so on Windows this fails if the script is picked.
    #[test]
    fn a_cli_installed_by_npm_actually_starts() {
        let mut command = command("npm");
        command.arg("--version");
        let output = crate::process::run(command, Duration::from_secs(60)).unwrap();
        assert!(output.ok, "npm --version failed: {}", output.stderr);
    }

    #[test]
    #[cfg(windows)]
    fn windows_never_picks_an_extensionless_file() {
        assert!(executable_names("claude").iter().all(|name| name.contains('.')));
        assert_eq!(executable_names("wt.exe"), vec!["wt.exe".to_string()]);
    }

    #[test]
    fn an_unknown_program_resolves_to_its_own_name() {
        assert_eq!(resolve("definitely-not-a-program-9f3a"), PathBuf::from("definitely-not-a-program-9f3a"));
    }
}
