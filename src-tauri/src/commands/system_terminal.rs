use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;

use crate::commands::editor::which;
use crate::error::{Error, Result};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemTerminal {
    pub command: String,
    pub name: String,
}

/// Terminal emulators worth opening, best first. `x-terminal-emulator` leads on
/// the systems that have it because it is whichever one the person chose.
const TERMINALS: &[(&str, &str)] = &[
    ("x-terminal-emulator", "your terminal"),
    ("gnome-terminal", "GNOME Terminal"),
    ("konsole", "Konsole"),
    ("kitty", "kitty"),
    ("alacritty", "Alacritty"),
    ("wezterm", "WezTerm"),
    ("xfce4-terminal", "Xfce Terminal"),
    ("xterm", "xterm"),
];

pub fn available(on_path: impl Fn(&str) -> bool) -> Vec<SystemTerminal> {
    TERMINALS
        .iter()
        .filter(|(command, _)| on_path(command))
        .map(|(command, name)| SystemTerminal {
            command: command.to_string(),
            name: name.to_string(),
        })
        .collect()
}

#[tauri::command]
pub fn list_terminals() -> Vec<SystemTerminal> {
    if cfg!(target_os = "macos") {
        // Terminal.app is always there; it is driven through osascript.
        return vec![SystemTerminal { command: "osascript".into(), name: "Terminal".into() }];
    }
    if cfg!(windows) {
        let terminal = if which("wt").is_some() {
            SystemTerminal { command: "wt".into(), name: "Windows Terminal".into() }
        } else {
            SystemTerminal { command: "cmd".into(), name: "Command Prompt".into() }
        };
        return vec![terminal];
    }
    available(|command| which(command).is_some())
}

/// macOS: Terminal.app opened at `cwd`, running `run` when given.
fn mac_arguments(cwd: &str, run: Option<&str>) -> Vec<String> {
    let line = match run {
        Some(run) => format!("cd {} && {run}", shell_words::quote(cwd)),
        None => format!("cd {}", shell_words::quote(cwd)),
    };
    let escaped = line.replace('\\', "\\\\").replace('"', "\\\"");
    vec![
        "-e".into(),
        format!("tell application \"Terminal\" to do script \"{escaped}\""),
        "-e".into(),
        "tell application \"Terminal\" to activate".into(),
    ]
}

/// Windows: Windows Terminal when installed, a new console window otherwise.
fn windows_arguments(emulator: &str, cwd: &str, run: Option<&str>) -> Vec<String> {
    match (emulator, run) {
        ("wt", Some(run)) => vec!["-d".into(), cwd.into(), "cmd".into(), "/k".into(), run.into()],
        ("wt", None) => vec!["-d".into(), cwd.into()],
        (_, Some(run)) => vec!["/c".into(), "start".into(), "cmd".into(), "/k".into(), run.into()],
        (_, None) => vec!["/c".into(), "start".into(), "cmd".into()],
    }
}

/// The arguments that make an emulator start in a directory and run something.
///
/// They disagree about this more than anything else: `-e` takes a command on
/// some, a whole shell line on others, and GNOME Terminal insists on `--`.
pub fn arguments(emulator: &str, cwd: &str, run: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = match emulator {
        "gnome-terminal" => vec!["--working-directory".into(), cwd.into()],
        "konsole" => vec!["--workdir".into(), cwd.into()],
        "kitty" => vec!["--directory".into(), cwd.into()],
        "wezterm" => vec!["start".into(), "--cwd".into(), cwd.into()],
        "alacritty" => vec!["--working-directory".into(), cwd.into()],
        "xfce4-terminal" => vec!["--working-directory".into(), cwd.into()],
        // xterm and x-terminal-emulator have no directory flag; the shell below
        // changes into it instead.
        _ => Vec::new(),
    };

    let command = match run {
        Some(run) => run.to_string(),
        None => return finish(emulator, args, None),
    };

    args = finish(emulator, args, Some(command));
    args
}

fn finish(emulator: &str, mut args: Vec<String>, run: Option<String>) -> Vec<String> {
    let Some(run) = run else {
        return args;
    };

    match emulator {
        "gnome-terminal" | "wezterm" => {
            args.push("--".into());
            args.extend(["sh".to_string(), "-c".into(), run]);
        }
        "kitty" | "alacritty" => {
            args.push("-e".into());
            args.extend(["sh".to_string(), "-c".into(), run]);
        }
        _ => {
            args.push("-e".into());
            args.push(format!("sh -c {}", shell_words::quote(&run)));
        }
    }
    args
}

#[tauri::command]
pub fn open_system_terminal(cwd: String, run: Option<String>) -> Result<String> {
    let directory = PathBuf::from(&cwd);
    if !directory.exists() {
        return Err(Error::Invalid(format!("{cwd} is not there any more")));
    }

    let emulator = list_terminals()
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("no terminal application found on this machine".into()))?;

    let args = if cfg!(target_os = "macos") {
        mac_arguments(&cwd, run.as_deref())
    } else if cfg!(windows) {
        windows_arguments(&emulator.command, &cwd, run.as_deref())
    } else {
        arguments(&emulator.command, &cwd, run.as_deref())
    };

    // Emulators without a directory flag are started in it instead.
    crate::platform::command(&emulator.command)
        .args(args)
        .current_dir(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::Invalid(format!("could not start {}: {e}", emulator.name)))?;

    Ok(emulator.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_emulator_gets_the_arguments_it_understands() {
        let gnome = arguments("gnome-terminal", "/work", Some("tmux attach -t x"));
        assert_eq!(gnome[0], "--working-directory");
        assert_eq!(gnome[1], "/work");
        assert_eq!(gnome[2], "--", "GNOME Terminal needs the separator");
        assert_eq!(gnome[3], "sh");

        let kitty = arguments("kitty", "/work", Some("tmux attach -t x"));
        assert_eq!(kitty[..2], ["--directory".to_string(), "/work".to_string()]);
        assert_eq!(kitty[2], "-e");

        // No directory flag: the command is a single shell string.
        let xterm = arguments("xterm", "/work", Some("tmux attach -t x"));
        assert_eq!(xterm[0], "-e");
        assert!(xterm[1].starts_with("sh -c "), "{:?}", xterm[1]);
    }

    #[test]
    fn mac_and_windows_open_in_the_directory() {
        let mac = mac_arguments("/my work", Some("tmux attach -t x"));
        assert!(mac[1].contains("do script"), "{:?}", mac[1]);
        assert!(mac[1].contains("cd '/my work' && tmux attach -t x"), "{:?}", mac[1]);

        assert_eq!(windows_arguments("wt", "C:\\w", None), ["-d", "C:\\w"]);
        assert_eq!(windows_arguments("cmd", "C:\\w", Some("claude"))[3..], ["/k", "claude"]);
    }

    #[test]
    fn opening_a_plain_terminal_asks_for_no_command() {
        assert_eq!(
            arguments("gnome-terminal", "/work", None),
            ["--working-directory", "/work"]
        );
        assert!(arguments("xterm", "/work", None).is_empty());
    }
}
