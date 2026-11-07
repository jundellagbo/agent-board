use rusqlite::params;

use crate::commands::groups::seed_defaults;
use crate::db::Db;

fn project(db: &Db) -> String {
    db.tx(|tx| {
        tx.execute("INSERT INTO organizations (id, name) VALUES ('o1', 'Acme')", [])?;
        tx.execute(
            "INSERT INTO projects (id, org_id, name, path) VALUES ('p1', 'o1', 'app', '/tmp/app')",
            [],
        )?;
        seed_defaults(tx, "p1")?;
        Ok("p1".to_string())
    })
    .unwrap()
}

/// The cheap column has to stay cheap and stay narrow, or it stops being a
/// commit step and starts being a second agent doing whatever it likes.
#[test]
fn the_commit_column_runs_the_cheap_model_on_a_narrow_instruction() {
    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let (prompt, model): (String, String) = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT prompt, model FROM board_groups WHERE project_id = ?1 AND name = 'Commit'",
                params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();

    assert_eq!(model, "claude-haiku-4-5");
    assert!(prompt.contains("do not push"), "the commit step must not push");
    assert!(prompt.contains("Do not edit code"), "it commits, it does not work");

    let review: Option<String> = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT model FROM board_groups WHERE project_id = ?1 AND name = 'Agent Review'",
                params![project_id],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(review, None, "reviewing keeps whatever model the agent uses");
}

#[test]
fn defaults_route_todo_straight_to_review() {
    let db = Db::open_in_memory().unwrap();
    let id = project(&db);

    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name, board_type, auto_run FROM board_groups WHERE project_id = ?1 ORDER BY position",
        )?;
        let groups: Vec<(String, String, bool)> = stmt
            .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;

        assert_eq!(
            groups.iter().map(|g| g.0.as_str()).collect::<Vec<_>>(),
            ["Todo", "For Review", "Agent Review", "Commit", "Completed"]
        );
        assert_eq!(
            groups.iter().map(|g| g.1.as_str()).collect::<Vec<_>>(),
            ["todo", "review", "custom", "custom", "done"]
        );
        assert_eq!(
            groups.iter().filter(|g| g.2).map(|g| g.0.as_str()).collect::<Vec<_>>(),
            ["Todo", "Agent Review", "Commit"],
            "the columns the runner claims from"
        );
        assert!(groups[0].2, "Todo is the column the runner claims from");

        let (running, success): (Option<String>, String) = conn.query_row(
            "SELECT (SELECT name FROM board_groups WHERE id = t.running_group_id), s.name
               FROM board_groups t
               JOIN board_groups s ON s.id = t.success_group_id
              WHERE t.board_type = 'todo'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert_eq!(running, None, "a card being worked on stays where it is");
        assert_eq!(success, "For Review");
        Ok(())
    })
    .unwrap();
}

/// Every outcome that is not an explicit success leaves the card alone. Agent
/// Review in particular hands work forward only because a person moved it.
#[test]
fn the_seeded_columns_route_only_where_they_should() {
    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let routes = db
        .with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT source.name,
                        coalesce((SELECT name FROM board_groups WHERE id = source.running_group_id), '-'),
                        coalesce((SELECT name FROM board_groups WHERE id = source.success_group_id), '-'),
                        coalesce((SELECT name FROM board_groups WHERE id = source.failure_group_id), '-')
                   FROM board_groups source
                  WHERE source.project_id = ?1
                  ORDER BY source.position",
            )?;
            let rows = stmt
                .query_map(params![project_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();

    assert_eq!(
        routes,
        vec![
            ("Todo".into(), "-".into(), "For Review".into(), "-".into()),
            ("For Review".into(), "-".into(), "-".into(), "-".into()),
            ("Agent Review".into(), "-".into(), "-".into(), "-".into()),
            ("Commit".into(), "-".into(), "Completed".into(), "-".into()),
            ("Completed".into(), "-".into(), "-".into(), "-".into()),
        ]
    );
}

/// The whole point of the board types: a run's exit code, not the UI, decides
/// where the card ends up.
#[test]
fn a_run_routes_the_card_by_its_exit_code() {
    use crate::commands::runs;

    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let column = |task: &str| -> String {
        db.with(|conn| {
            Ok(conn.query_row(
                "SELECT g.name FROM tasks t JOIN board_groups g ON g.id = t.group_id \
                 WHERE t.id = ?1",
                params![task],
                |r| r.get(0),
            )?)
        })
        .unwrap()
    };

    // A run that fails leaves the card where it is, marked failed, rather than
    // routing it anywhere. Nothing re-claims it: only an idle card is picked up.
    for (id, exit_code, expected) in [("t-ok", 0, "For Review"), ("t-bad", 1, "Todo")] {
        db.with(|conn| {
            let todo: String = conn.query_row(
                "SELECT id FROM board_groups WHERE project_id = ?1 AND board_type = 'todo'",
                params![project_id],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO tasks (id, project_id, group_id, title) VALUES (?1, ?2, ?3, 'work')",
                params![id, project_id, todo],
            )?;
            Ok(())
        })
        .unwrap();

        let run = db
            .tx(|tx| runs::claim(tx, id, "claude {prompt}", "/tmp", None))
            .unwrap();
        assert_eq!(column(id), "Todo", "with no running lane, claiming leaves the card put");

        let task = db
            .tx(|tx| runs::finish(tx, &run.id, exit_code, "exited", None))
            .unwrap();
        assert_eq!(column(id), expected);
        assert_eq!(task.run_state, if exit_code == 0 { "done" } else { "failed" });
    }
}

#[test]
fn indexing_makes_a_project_searchable() {
    use crate::commands::index;

    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let root = std::env::temp_dir().join(format!("agent-board-search-{}", crate::db::new_id()));
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/board.rs"), "fn claim_task() { todo!() }").unwrap();
    std::fs::write(root.join("notes.md"), "nothing to see").unwrap();

    db.with(|conn| {
        conn.execute(
            "UPDATE projects SET path = ?2 WHERE id = ?1",
            params![project_id, root.to_string_lossy()],
        )?;
        Ok(())
    })
    .unwrap();

    let project = db
        .with(|conn| crate::commands::projects::get(conn, &project_id))
        .unwrap();
    let indexed = index::build_for_test(&db, &project).unwrap();
    assert_eq!(indexed, 2);

    let hits = db
        .with(|conn| index::search_for_test(conn, &project_id, "claim_task", None))
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "src/board.rs");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_card_started_from_a_column_with_no_running_lane_still_lands_in_progress() {
    use crate::commands::runs;

    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    // A board someone gave a working lane to: no column routes into it, so the
    // board type is the only thing that says where a running card belongs.
    db.with(|conn| {
        let review: String = conn.query_row(
            "SELECT id FROM board_groups WHERE project_id = ?1 AND name = 'Agent Review'",
            params![project_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO board_groups (id, project_id, name, board_type, position)
             VALUES ('wip', ?1, 'Working', 'in_progress', 9)",
            params![project_id],
        )?;
        conn.execute(
            "INSERT INTO tasks (id, project_id, group_id, title) VALUES ('t1', ?1, ?2, 'work')",
            params![project_id, review],
        )?;
        Ok(())
    })
    .unwrap();

    db.tx(|tx| runs::claim(tx, "t1", "claude", "/tmp", None)).unwrap();

    let landed: String = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT g.board_type FROM tasks t JOIN board_groups g ON g.id = t.group_id
                  WHERE t.id = 't1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(landed, "in_progress");
}

#[test]
fn a_board_with_no_in_progress_column_leaves_a_running_card_where_it_is() {
    use crate::commands::runs;

    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let review = db
        .with(|conn| {
            let review: String = conn.query_row(
                "SELECT id FROM board_groups WHERE project_id = ?1 AND name = 'Agent Review'",
                params![project_id],
                |r| r.get(0),
            )?;
            conn.execute(
                "UPDATE board_groups SET board_type = 'custom' WHERE board_type = 'in_progress'",
                [],
            )?;
            conn.execute(
                "INSERT INTO tasks (id, project_id, group_id, title) VALUES ('t1', ?1, ?2, 'work')",
                params![project_id, review],
            )?;
            Ok(review)
        })
        .unwrap();

    db.tx(|tx| runs::claim(tx, "t1", "claude", "/tmp", None)).unwrap();

    let landed: String = db
        .with(|conn| Ok(conn.query_row("SELECT group_id FROM tasks WHERE id = 't1'", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(landed, review);
}

#[test]
fn runs_left_over_from_a_crash_are_closed_at_startup() {
    use crate::commands::runs;

    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    db.with(|conn| {
        let todo: String = conn.query_row(
            "SELECT id FROM board_groups WHERE project_id = ?1 AND board_type = 'todo'",
            params![project_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO tasks (id, project_id, group_id, title) VALUES ('t1', ?1, ?2, 'work')",
            params![project_id, todo],
        )?;
        Ok(())
    })
    .unwrap();

    db.tx(|tx| runs::claim(tx, "t1", "claude", "/tmp", None)).unwrap();

    let closed = db.with(runs::reconcile).unwrap();
    assert_eq!(closed, 1);

    let (status, state): (String, String) = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT r.status, t.run_state FROM task_runs r JOIN tasks t ON t.id = r.task_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "killed");
    assert_eq!(state, "idle", "the card is claimable again, not stuck running");
}

/// The upgrade has to be safe on a board someone has made their own, which is
/// the whole reason it matches on the exact original four columns.
#[test]
fn old_boards_gain_the_pipeline_and_edited_boards_are_left_alone() {
    const UPGRADE: &str = include_str!("../../migrations/0009_pipeline_columns.sql");

    let db = Db::open_in_memory().unwrap();
    let columns = |project: &str| -> Vec<String> {
        db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name FROM board_groups WHERE project_id = ?1 ORDER BY position",
            )?;
            let names = stmt
                .query_map(params![project], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(names)
        })
        .unwrap()
    };

    db.with(|conn| {
        conn.execute("INSERT INTO organizations (id, name) VALUES ('o1', 'Acme')", [])?;
        for (id, path) in [("old", "/tmp/old"), ("mine", "/tmp/mine")] {
            conn.execute(
                "INSERT INTO projects (id, org_id, name, path) VALUES (?1, 'o1', ?1, ?2)",
                params![id, path],
            )?;
        }

        // One untouched board, and one where a person renamed a column.
        for (project, names) in [
            ("old", ["Todo", "In Progress", "In Review", "Completed"]),
            ("mine", ["Todo", "Doing", "In Review", "Completed"]),
        ] {
            for (position, name) in names.iter().enumerate() {
                conn.execute(
                    "INSERT INTO board_groups (id, project_id, name, board_type, position)
                     VALUES (?1, ?2, ?3, 'custom', ?4)",
                    params![format!("{project}-{position}"), project, name, position as i64],
                )?;
            }
        }
        Ok(())
    })
    .unwrap();

    db.with(|conn| Ok(conn.execute_batch(UPGRADE)?)).unwrap();

    assert_eq!(
        columns("old"),
        ["Todo", "In Progress", "For Review", "Agent Review", "Commit", "Completed"]
    );
    assert_eq!(
        columns("mine"),
        ["Todo", "Doing", "In Review", "Completed"],
        "a board someone has edited is theirs"
    );

    let routed: String = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT target.name
                   FROM board_groups source
                   JOIN board_groups target ON target.id = source.success_group_id
                  WHERE source.project_id = 'old' AND source.name = 'Agent Review'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(routed, "Commit");
}

/// "Blocked" and "failed" route the same way but mean different things: one is
/// the agent reporting it could not finish, the other is the process going wrong.
#[test]
fn a_blocked_run_is_told_apart_from_a_failed_one() {
    use crate::commands::runs;

    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let column = |task: &str| -> String {
        db.with(|conn| {
            Ok(conn.query_row(
                "SELECT g.name FROM tasks t JOIN board_groups g ON g.id = t.group_id \
                 WHERE t.id = ?1",
                params![task],
                |r| r.get(0),
            )?)
        })
        .unwrap()
    };

    db.with(|conn| {
        let todo: String = conn.query_row(
            "SELECT id FROM board_groups WHERE project_id = ?1 AND board_type = 'todo'",
            params![project_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO tasks (id, project_id, group_id, title) VALUES ('t1', ?1, ?2, 'work')",
            params![project_id, todo],
        )?;
        Ok(())
    })
    .unwrap();

    let run = db.tx(|tx| runs::claim(tx, "t1", "claude", "/tmp", None)).unwrap();
    let task = db.tx(|tx| runs::finish(tx, &run.id, 1, "blocked", Some("could not do it"))).unwrap();

    assert_eq!(task.run_state, "blocked", "not the same as a crash");
    assert_eq!(
        column("t1"),
        "Todo",
        "and like any other failure it stays where it was working"
    );
}

/// The upgrades have to land on the routing a fresh board is seeded with, and
/// leave a board someone has made their own alone. An old board keeps its
/// working lane as a column — removing one is nobody's business but its owner's
/// — but nothing routes into it any more, which is the part that matters.
#[test]
fn settling_the_routing_matches_a_fresh_board() {
    const SETTLE: &str = include_str!("../../migrations/0011_settle_routing.sql");
    const DROP_LANE: &str = include_str!("../../migrations/0016_no_running_lane.sql");

    let db = Db::open_in_memory().unwrap();
    let fresh = project(&db);

    let routes = |project: &str| -> Vec<(String, String, String)> {
        db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT source.name,
                        coalesce((SELECT name FROM board_groups WHERE id = source.success_group_id), '-'),
                        coalesce((SELECT name FROM board_groups WHERE id = source.failure_group_id), '-')
                   FROM board_groups source
                  WHERE source.project_id = ?1
                  ORDER BY source.position",
            )?;
            let rows = stmt
                .query_map(params![project], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
    };
    let expected = routes(&fresh);

    // A board seeded before this change: failures routed, Agent Review handed
    // its work to Commit, and the working lane routed nowhere.
    db.with(|conn| {
        conn.execute(
            "INSERT INTO projects (id, org_id, name, path) VALUES ('old', 'o1', 'old', '/tmp/old')",
            [],
        )?;
        for (position, name) in ["Todo", "In Progress", "For Review", "Agent Review", "Commit", "Completed"]
            .iter()
            .enumerate()
        {
            conn.execute(
                "INSERT INTO board_groups (id, project_id, name, board_type, position)
                 VALUES (?1, 'old', ?2, 'custom', ?3)",
                params![format!("old-{position}"), name, position as i64],
            )?;
        }
        conn.execute(
            "UPDATE board_groups SET failure_group_id = 'old-0' WHERE id = 'old-0'",
            [],
        )?;
        conn.execute(
            "UPDATE board_groups SET success_group_id = 'old-4', failure_group_id = 'old-2'
              WHERE id = 'old-3'",
            [],
        )?;
        conn.execute(
            "UPDATE board_groups SET success_group_id = 'old-5', failure_group_id = 'old-2'
              WHERE id = 'old-4'",
            [],
        )?;
        conn.execute("UPDATE board_groups SET success_group_id = 'old-2' WHERE id = 'old-0'", [])?;
        conn.execute(
            "UPDATE board_groups SET running_group_id = 'old-1' WHERE id = 'old-0'",
            [],
        )?;

        // And a board someone renamed a column on.
        conn.execute(
            "INSERT INTO projects (id, org_id, name, path) VALUES ('mine', 'o1', 'mine', '/tmp/mine')",
            [],
        )?;
        conn.execute(
            "INSERT INTO board_groups (id, project_id, name, board_type, position, failure_group_id)
             VALUES ('mine-0', 'mine', 'Backlog', 'todo', 0, 'mine-0')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    db.with(|conn| Ok(conn.execute_batch(SETTLE)?)).unwrap();
    db.with(|conn| Ok(conn.execute_batch(DROP_LANE)?)).unwrap();

    // The one column a fresh board no longer has, inert where it stands.
    let mut settled = routes("old");
    let lane = settled.remove(1);
    assert_eq!(lane.0, "In Progress");
    assert_eq!(settled, expected, "an old board ends up where a new one starts");

    let into_lane: i64 = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT count(*) FROM board_groups
                  WHERE project_id = 'old' AND running_group_id IS NOT NULL",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(into_lane, 0, "nothing moves a card into the lane any more");

    let mine: Option<String> = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT failure_group_id FROM board_groups WHERE id = 'mine-0'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(mine.as_deref(), Some("mine-0"), "a board someone changed keeps its routing");
}

/// A card only opens itself to remote control because someone asked it to.
#[test]
fn a_new_card_keeps_remote_control_off() {
    let db = Db::open_in_memory().unwrap();
    let project_id = project(&db);

    let group: String = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM board_groups WHERE project_id = ?1 AND board_type = 'todo'",
                params![project_id],
                |r| r.get(0),
            )?)
        })
        .unwrap();

    db.with(|conn| {
        conn.execute(
            "INSERT INTO tasks (id, project_id, group_id, title, remote)
             VALUES ('t1', ?1, ?2, 'work', 0)",
            params![project_id, group],
        )?;
        Ok(())
    })
    .unwrap();

    let remote: bool = db
        .with(|conn| Ok(conn.query_row("SELECT remote FROM tasks WHERE id = 't1'", [], |r| r.get(0))?))
        .unwrap();
    assert!(!remote);
}
