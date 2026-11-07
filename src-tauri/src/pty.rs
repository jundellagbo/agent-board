use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::db::new_id;
use crate::error::{Error, Result};

pub const OUTPUT_EVENT: &str = "pty://output";
pub const EXIT_EVENT: &str = "pty://exit";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub id: String,
    /// base64 — terminal output is arbitrary bytes and a chunk boundary can land
    /// mid-codepoint, which lossy UTF-8 conversion would silently corrupt.
    pub bytes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub code: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub cwd: String,
    /// Full command line, split with shell rules. Empty means the login shell.
    pub command: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// A tmux session name, so a real terminal can attach to this same session.
    pub share_as: Option<String>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl PtyManager {
    pub fn spawn<R: Runtime>(&self, app: &AppHandle<R>, options: SpawnOptions) -> Result<String> {
        let pty = NativePtySystem::default()
            .openpty(PtySize {
                rows: options.rows.unwrap_or(24),
                cols: options.cols.unwrap_or(80),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Invalid(format!("could not open a pty: {e}")))?;

        let mut command = build_command(&options)?;
        command.cwd(&options.cwd);
        for (key, value) in &options.env {
            command.env(key, value);
        }
        // Agents render TUIs; without a sane TERM they fall back to dumb output.
        command.env("TERM", "xterm-256color");

        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|e| Error::Invalid(format!("could not start the command: {e}")))?;
        drop(pty.slave);

        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| Error::Invalid(format!("could not read the pty: {e}")))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| Error::Invalid(format!("could not write to the pty: {e}")))?;

        let id = new_id();
        self.sessions.lock().expect("pty mutex poisoned").insert(
            id.clone(),
            Session {
                master: pty.master,
                writer,
                child,
            },
        );

        pump(app.clone(), self.sessions.clone(), id.clone(), reader);
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().expect("pty mutex poisoned");
        let session = sessions.get_mut(id).ok_or_else(|| missing(id))?;
        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions.lock().expect("pty mutex poisoned");
        let session = sessions.get(id).ok_or_else(|| missing(id))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Invalid(format!("could not resize the pty: {e}")))
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().expect("pty mutex poisoned");
        let session = sessions.get_mut(id).ok_or_else(|| missing(id))?;
        session.child.kill()?;
        Ok(())
    }

    pub fn ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .expect("pty mutex poisoned")
            .keys()
            .cloned()
            .collect()
    }
}

/// Streams the pty to the frontend until it closes, then reaps the child and
/// reports its exit code — that code is what decides where a card lands.
fn pump<R: Runtime>(
    app: AppHandle<R>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    id: String,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let payload = PtyOutput {
                        id: id.clone(),
                        bytes: base64::engine::general_purpose::STANDARD.encode(&buffer[..read]),
                    };
                    if app.emit(OUTPUT_EVENT, payload).is_err() {
                        break;
                    }
                }
            }
        }

        let mut session = sessions.lock().expect("pty mutex poisoned").remove(&id);
        let code = session
            .as_mut()
            .and_then(|session| session.child.wait().ok())
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        let _ = app.emit(EXIT_EVENT, PtyExit { id, code });
    });
}

fn build_command(options: &SpawnOptions) -> Result<CommandBuilder> {
    let line = options.command.as_deref().unwrap_or("").trim();
    let parts = if line.is_empty() {
        vec![default_shell()]
    } else {
        shell_words::split(line)
            .map_err(|e| Error::Invalid(format!("could not parse the command: {e}")))?
    };

    let parts = match options.share_as.as_deref() {
        Some(name) if tmux_available() => tmux_wrapper(name, &parts),
        _ => parts,
    };

    let (program, args) = parts
        .split_first()
        .ok_or_else(|| Error::Invalid("the command is empty".into()))?;

    let mut command = CommandBuilder::new(program);
    command.args(args);
    Ok(command)
}

/// Runs the agent inside a named tmux session so a real terminal can attach to
/// the very session this app is showing, rather than a second one beside it.
/// Without tmux the command runs directly and the session stays app-only.
fn tmux_wrapper(name: &str, parts: &[String]) -> Vec<String> {
    let mut wrapped = vec![
        "tmux".to_string(),
        "new-session".into(),
        // -A attaches if it is already there, so a re-run rejoins rather than
        // failing on a duplicate name.
        "-A".into(),
        "-s".into(),
        name.to_string(),
        "--".into(),
    ];
    wrapped.extend(parts.iter().cloned());
    wrapped
}

/// Whether a card's agent is still sitting in its tmux session.
///
/// The pty this app owned dies with the window, but tmux outlives it — the
/// agent is usually still at its own prompt, waiting to be told what to do
/// next. `=name` is an exact match; without it tmux matches on prefix and one
/// card would find another card's session.
pub fn shared_exists(name: &str) -> bool {
    if !tmux_available() {
        return false;
    }
    let mut command = std::process::Command::new("tmux");
    command.args(["has-session", "-t", &format!("={name}")]);
    crate::process::run(command, std::time::Duration::from_secs(5))
        .is_ok_and(|output| output.ok)
}

fn tmux_available() -> bool {
    crate::commands::editor::which("tmux").is_some()
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

fn missing(id: &str) -> Error {
    Error::NotFound(format!("terminal session {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_streams_and_the_exit_code_comes_back() {
        use std::sync::mpsc::channel;
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let (tx, rx) = channel();

        let output = tx.clone();
        handle.listen(OUTPUT_EVENT, move |event| {
            let payload: PtyOutput = serde_json::from_str(event.payload()).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload.bytes)
                .unwrap();
            let _ = output.send(Some(String::from_utf8_lossy(&bytes).to_string()));
        });
        handle.listen(EXIT_EVENT, move |event| {
            let payload: PtyExit = serde_json::from_str(event.payload()).unwrap();
            let _ = tx.send(None);
            assert_eq!(payload.code, 0);
        });

        let manager = PtyManager::default();
        manager
            .spawn(
                &handle,
                SpawnOptions {
                    cwd: "/tmp".into(),
                    command: Some("echo agent-board".into()),
                    env: HashMap::new(),
                    cols: Some(80),
                    rows: Some(24),
                    share_as: None,
                },
            )
            .unwrap();

        let mut seen = String::new();
        while let Ok(message) = rx.recv_timeout(std::time::Duration::from_secs(10)) {
            match message {
                Some(chunk) => seen.push_str(&chunk),
                None => break,
            }
        }
        assert!(seen.contains("agent-board"), "pty output was {seen:?}");
        assert!(manager.ids().is_empty(), "the session is dropped once it exits");
    }

    #[test]
    fn a_shared_session_runs_inside_tmux() {
        let parts = vec!["claude".to_string(), "--model".into(), "opus".into()];
        let wrapped = tmux_wrapper("agent-board-t1", &parts);

        assert_eq!(
            wrapped,
            [
                "tmux",
                "new-session",
                "-A",
                "-s",
                "agent-board-t1",
                "--",
                "claude",
                "--model",
                "opus"
            ],
            "-A rejoins an existing session rather than failing on the name"
        );
    }

    #[test]
    fn a_blank_command_falls_back_to_the_login_shell() {
        let options = SpawnOptions {
            cwd: "/tmp".into(),
            command: Some("   ".into()),
            env: HashMap::new(),
            cols: None,
            rows: None,
            share_as: None,
        };
        assert!(!build_command(&options).unwrap().get_argv().is_empty());
    }

    #[test]
    fn quoted_arguments_survive_splitting() {
        let options = SpawnOptions {
            cwd: "/tmp".into(),
            command: Some("claude -p \"fix the flaky test\"".into()),
            env: HashMap::new(),
            cols: None,
            rows: None,
            share_as: None,
        };
        let argv = build_command(&options).unwrap().get_argv().to_vec();
        assert_eq!(argv, ["claude", "-p", "fix the flaky test"]);
    }
}
