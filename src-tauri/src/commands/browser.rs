use std::path::Path;

/// The `--mcp-config` value that points a run's Chrome DevTools server at the
/// app's one approved Chrome connection, or None to leave the agent as it is.
#[tauri::command]
pub fn browser_mcp_config(cwd: String) -> Option<String> {
    crate::browser_bridge::mcp_config(Path::new(&cwd))
}
