use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

pub const CHANGED_EVENT: &str = "board://changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardChanged {
    pub project_id: String,
}

/// Tells every window that a project's cards moved.
///
/// The board used to re-read only when the window that started a run asked it
/// to, so a card finishing after that window navigated away — or in another
/// window, or after a restart — stayed on screen as it was. Announcing from the
/// place that makes the change means nobody has to remember to ask.
pub fn announce<R: Runtime>(app: &AppHandle<R>, project_id: &str) {
    let _ = app.emit(
        CHANGED_EVENT,
        BoardChanged {
            project_id: project_id.to_string(),
        },
    );
}
