mod board_events;
mod browser_bridge;
mod catalog;
mod commands;
mod db;
mod error;
mod git;
mod github;
mod indexer;
mod models;
mod platform;
mod process;
mod pty;
mod trust;

use tauri::Manager;

use db::Db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything spawns a CLI: a GUI launch would otherwise miss them.
    platform::inherit_login_path();
    tauri::Builder::default()
        // One window per machine: every instance would otherwise open the same
        // SQLite file, and two runners would claim the same cards.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::agents::list_agents,
            commands::agents::save_agent,
            commands::agents::delete_agent,
            commands::orgs::list_orgs,
            commands::orgs::create_org,
            commands::orgs::rename_org,
            commands::orgs::delete_org,
            commands::projects::list_projects,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            commands::index::index_project,
            commands::index::unindex_project,
            commands::index::indexed_files,
            commands::index::search_project,
            commands::groups::list_groups,
            commands::groups::create_group,
            commands::groups::update_group,
            commands::groups::delete_group,
            commands::groups::reorder_groups,
            commands::runs::claim_task,
            commands::runs::finish_run,
            commands::runs::cancel_run,
            commands::runs::reconcile_runs,
            commands::runs::list_runs,
            commands::mcp::mcp_catalog,
            commands::mcp::install_mcp,
            commands::mcp::install_custom_mcp,
            commands::mcp::uninstall_mcp,
            commands::notify::post_webhooks,
            commands::plugins::list_plugins,
            commands::plugins::install_plugin,
            commands::plugins::uninstall_plugin,
            commands::editor::list_editors,
            commands::system_terminal::list_terminals,
            commands::system_terminal::open_system_terminal,
            commands::editor::open_in_editor,
            commands::slash::list_slash_commands,
            commands::browser::browser_mcp_config,
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::clear_setting,
            commands::tasks::list_tasks,
            commands::tasks::create_task,
            commands::tasks::resolve_github,
            commands::tasks::update_task,
            commands::tasks::delete_task,
            commands::tasks::move_task,
            commands::tasks::reorder_tasks,
            commands::worktrees::ensure_worktree,
            commands::worktrees::list_branches,
            commands::worktrees::remove_worktree,
            commands::worktrees::list_worktrees,
            commands::worktrees::remove_project_worktree,
            commands::terminal::pty_spawn,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_kill,
            commands::terminal::pty_sessions,
            commands::terminal::pty_shared,
            commands::tmp::list_tmp,
            commands::tmp::add_tmp,
            commands::tmp::collect_tmp,
            commands::tmp::read_tmp,
            commands::tmp::tmp_dir,
            commands::tmp::screenshot_tmp,
            commands::tmp::paste_tmp,
            commands::tmp::delete_tmp,
            commands::tmp::clear_tmp,
            commands::tmp::reveal_tmp,
            commands::tmp::reveal_project_tmp,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let path = app.path().app_data_dir()?.join("agent-board.db");
            log::info!("opening database at {}", path.display());
            let db = Db::open(&path)?;
            db.with(commands::agents::seed_built_ins)?;
            // Everything already on the board was added deliberately, so record
            // trust for it too — otherwise only projects added from now on run
            // unattended.
            let known = db.with(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT path FROM projects
                     UNION
                     SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL",
                )?;
                let paths = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(paths)
            })?;
            let known: Vec<std::path::PathBuf> = known.into_iter().map(Into::into).collect();
            match trust::trust_all(&known) {
                Ok(true) => log::info!("recorded workspace trust for {} path(s)", known.len()),
                Ok(false) => {}
                Err(error) => log::warn!("could not record workspace trust: {error}"),
            }

            let orphaned = db.with(commands::runs::reconcile)?;
            if orphaned > 0 {
                log::info!("closed {orphaned} run(s) left over from the last session");
            }
            app.manage(db);
            app.manage(pty::PtyManager::default());

            // Not fatal: without it the tmp lists still work, they just stop
            // noticing files that something other than this app put there.
            if let Err(error) = commands::tmp::watch(app.handle().clone()) {
                log::warn!("could not watch the tmp store: {error}");
            }
            commands::slash::warm();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
