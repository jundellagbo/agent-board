use std::path::PathBuf;
use std::process::{Command, Stdio};

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
    available(|command| which(command).is_some())
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

    // Emulators without a directory flag are started in it instead.
    Command::new(&emulator.command)
        .args(arguments(&emulator.command, &cwd, run.as_deref()))
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
    fn opening_a_plain_terminal_asks_for_no_command() {
        assert_eq!(
            arguments("gnome-terminal", "/work", None),
            ["--working-directory", "/work"]
        );
        assert!(arguments("xterm", "/work", None).is_empty());
    }
}
