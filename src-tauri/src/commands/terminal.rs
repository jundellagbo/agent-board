use tauri::{AppHandle, State};

use crate::error::Result;
use crate::pty::{PtyManager, SpawnOptions};

#[tauri::command]
pub fn pty_spawn(app: AppHandle, pty: State<PtyManager>, options: SpawnOptions) -> Result<String> {
    pty.spawn(&app, options)
}

#[tauri::command]
pub fn pty_write(pty: State<PtyManager>, id: String, data: String) -> Result<()> {
    pty.write(&id, &data)
}

#[tauri::command]
pub fn pty_resize(pty: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<()> {
    pty.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(pty: State<PtyManager>, id: String) -> Result<()> {
    pty.kill(&id)
}

#[tauri::command]
pub fn pty_sessions(pty: State<PtyManager>) -> Vec<String> {
    pty.ids()
}
