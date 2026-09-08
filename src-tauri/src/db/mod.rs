pub mod migrations;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::Result;

/// The single owner of the SQLite connection. Every command goes through
/// `with`, so callers can never hold the lock across an await or a PTY read.
pub struct Db(Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::configure(&conn)?;
        migrations::run(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn)?;
        migrations::run(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    fn configure(conn: &Connection) -> Result<()> {
        // WAL survives a hard power loss with the last committed write intact,
        // which is the whole point of boards outliving a restart.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(())
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.0.lock().expect("db mutex poisoned");
        f(&conn)
    }

    /// Runs `f` inside a transaction, rolling back on any error.
    pub fn tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.0.lock().expect("db mutex poisoned");
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}

pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_an_org_cascades_to_its_projects() {
        let db = Db::open_in_memory().unwrap();
        db.with(|conn| {
            conn.execute("INSERT INTO organizations (id, name) VALUES ('o1', 'Acme')", [])?;
            conn.execute(
                "INSERT INTO projects (id, org_id, name, path) VALUES ('p1', 'o1', 'app', '/tmp/app')",
                [],
            )?;
            conn.execute("DELETE FROM organizations WHERE id = 'o1'", [])?;

            let projects: i64 =
                conn.query_row("SELECT count(*) FROM projects", [], |r| r.get(0))?;
            assert_eq!(projects, 0);
            Ok(())
        })
        .unwrap();
    }
}
