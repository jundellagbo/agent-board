use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    /// Stable across machines, so a remembered choice survives a reinstall that
    /// moves the binary.
    pub id: String,
    pub name: String,
    /// The CLI or bundle that was actually found. Shown in the menu because two
    /// installs of the same editor are common and only the path tells them apart.
    pub program: String,
    #[serde(skip)]
    launch: Launch,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Launch {
    /// Run the program with the directory as its argument.
    Direct,
    /// `open -a` the bundle: a macOS app installed without its shell command.
    MacApp,
}

struct Known {
    id: &'static str,
    name: &'static str,
    /// Launcher commands to look for on PATH, best first.
    commands: &'static [&'static str],
    /// The macOS bundle to fall back on when the command was never installed.
    bundle: &'static str,
}

/// The editors this app knows how to open a directory in, best first.
///
/// The order is the whole policy: with nothing chosen, the first one installed
/// wins, so VS Code leads. Everything below it is a fallback, not a ranking of
/// editors — it exists so a machine without VS Code still gets a working menu.
const KNOWN: &[Known] = &[
    Known {
        id: "vscode",
        name: "Visual Studio Code",
        commands: &["code"],
        bundle: "Visual Studio Code.app",
    },
    Known {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        commands: &["code-insiders"],
        bundle: "Visual Studio Code - Insiders.app",
    },
    Known {
        id: "vscodium",
        name: "VSCodium",
        commands: &["codium"],
        bundle: "VSCodium.app",
    },
    Known {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        bundle: "Cursor.app",
    },
    Known {
        id: "windsurf",
        name: "Windsurf",
        commands: &["windsurf"],
        bundle: "Windsurf.app",
    },
    Known {
        id: "zed",
        name: "Zed",
        commands: &["zed", "zeditor"],
        bundle: "Zed.app",
    },
    Known {
        id: "sublime",
        name: "Sublime Text",
        commands: &["subl"],
        bundle: "Sublime Text.app",
    },
    Known {
        id: "webstorm",
        name: "WebStorm",
        commands: &["webstorm"],
        bundle: "WebStorm.app",
    },
    Known {
        id: "idea",
        name: "IntelliJ IDEA",
        commands: &["idea"],
        bundle: "IntelliJ IDEA.app",
    },
    Known {
        id: "pycharm",
        name: "PyCharm",
        commands: &["pycharm"],
        bundle: "PyCharm.app",
    },
];

/// Every editor installed on this machine, in [`KNOWN`] order.
pub fn detect() -> Vec<Editor> {
    KNOWN.iter().filter_map(find).collect()
}

/// The editor a request should go to: the one asked for, else the first
/// installed. `None` for an id nothing matches, so a stale remembered choice
/// falls back instead of failing.
pub fn resolve(editors: Vec<Editor>, id: Option<&str>) -> Option<Editor> {
    let wanted = id.filter(|id| !id.is_empty());
    match wanted {
        Some(id) => editors
            .iter()
            .find(|editor| editor.id == id)
            .cloned()
            .or_else(|| editors.into_iter().next()),
        None => editors.into_iter().next(),
    }
}

fn find(known: &Known) -> Option<Editor> {
    let editor = |program: String, launch: Launch| Editor {
        id: known.id.to_string(),
        name: known.name.to_string(),
        program,
        launch,
    };

    if let Some(path) = known.commands.iter().find_map(|name| on_path(name)) {
        return Some(editor(path.to_string_lossy().to_string(), Launch::Direct));
    }
    bundle(known.bundle).map(|path| editor(path.to_string_lossy().to_string(), Launch::MacApp))
}

/// Opens `path` and returns without waiting: a cold editor start takes seconds,
/// and the menu it was clicked from should not sit there for them.
pub fn open(editor: &Editor, path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(Error::NotFound(format!("{} no longer exists", path.display())));
    }

    let mut command = match editor.launch {
        Launch::Direct => {
            let mut command = Command::new(&editor.program);
            command.arg(path);
            command
        }
        Launch::MacApp => {
            let mut command = Command::new("open");
            command.arg("-a").arg(&editor.program).arg(path);
            command
        }
    };

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|cause| {
            Error::Invalid(format!("could not start {}: {cause}", editor.name))
        })?;

    // A launcher exits the moment it has handed the directory to the running
    // editor; nothing is waiting on it here, so reap it rather than leave a
    // zombie behind for every open.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// A `which` that does not shell out, so PATH order decides exactly as it would
/// in the user's own terminal.
///
/// The extra directories matter on macOS: an app launched from Finder inherits
/// a minimal PATH that has never sourced a shell profile, so the `code` command
/// a person installed is invisible without them.
fn on_path(program: &str) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    roots.extend(extra_roots());

    roots.into_iter().find_map(|dir| {
        candidates(program)
            .into_iter()
            .map(|name| dir.join(name))
            .find(|candidate| is_executable(candidate))
    })
}

#[cfg(windows)]
fn extra_roots() -> Vec<PathBuf> {
    let programs = |var: &str, tail: &str| {
        std::env::var_os(var).map(|root| PathBuf::from(root).join(tail))
    };
    [
        programs("LOCALAPPDATA", r"Programs\Microsoft VS Code\bin"),
        programs("LOCALAPPDATA", r"Programs\cursor\resources\app\bin"),
        programs("ProgramFiles", r"Microsoft VS Code\bin"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(not(windows))]
fn extra_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    ["/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"]
        .iter()
        .map(PathBuf::from)
        .chain(home.map(|home| home.join(".local/bin")))
        .collect()
}

/// On Windows the launchers are `code.cmd` and friends, and PATHEXT is what
/// says so; elsewhere the name on PATH is the whole name.
#[cfg(windows)]
fn candidates(program: &str) -> Vec<String> {
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    std::iter::once(program.to_string())
        .chain(
            extensions
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(|extension| format!("{program}{}", extension.to_lowercase())),
        )
        .collect()
}

#[cfg(not(windows))]
fn candidates(program: &str) -> Vec<String> {
    vec![program.to_string()]
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(target_os = "macos")]
fn bundle(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    std::iter::once(PathBuf::from("/Applications"))
        .chain(home.map(|home| home.join("Applications")))
        .map(|root| root.join(name))
        .find(|path| path.is_dir())
}

#[cfg(not(target_os = "macos"))]
fn bundle(_name: &str) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor(id: &str) -> Editor {
        Editor {
            id: id.to_string(),
            name: id.to_string(),
            program: format!("/usr/bin/{id}"),
            launch: Launch::Direct,
        }
    }

    #[test]
    fn vs_code_leads_the_catalog() {
        assert_eq!(KNOWN[0].id, "vscode", "VS Code is the default editor");
    }

    #[test]
    fn every_known_editor_has_its_own_id() {
        let mut ids: Vec<_> = KNOWN.iter().map(|known| known.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "two editors share an id");
    }

    #[test]
    fn nothing_chosen_takes_the_first_installed() {
        let found = vec![editor("cursor"), editor("zed")];
        assert_eq!(resolve(found, None).unwrap().id, "cursor");
    }

    #[test]
    fn a_choice_that_is_installed_is_honoured() {
        let found = vec![editor("vscode"), editor("zed")];
        assert_eq!(resolve(found, Some("zed")).unwrap().id, "zed");
    }

    /// An editor can be uninstalled long after it was picked, and that must not
    /// turn every Open in editor into an error.
    #[test]
    fn a_choice_that_is_gone_falls_back_rather_than_failing() {
        let found = vec![editor("vscode")];
        assert_eq!(resolve(found, Some("sublime")).unwrap().id, "vscode");
    }

    #[test]
    fn no_editor_installed_resolves_to_nothing() {
        assert!(resolve(Vec::new(), Some("vscode")).is_none());
    }

    #[test]
    fn a_directory_that_is_gone_is_reported_rather_than_spawned() {
        let error = open(&editor("vscode"), Path::new("/no/such/directory")).unwrap_err();
        assert!(error.to_string().contains("no longer exists"), "{error}");
    }

    #[test]
    fn the_command_on_path_is_found() {
        // `sh` is on PATH on every machine this builds for.
        assert!(on_path("sh").is_some(), "sh should be on PATH");
        assert!(on_path("definitely-not-a-real-program").is_none());
    }
}
