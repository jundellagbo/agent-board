use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{Error, Result};

pub fn is_repo(path: &Path) -> bool {
    run(path, &["rev-parse", "--git-dir"]).is_ok()
}

/// Branch name for a card: readable in `git branch`, and safe for a path.
pub fn branch_name(title: &str) -> String {
    let slug: String = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    let slug = slug.chars().take(40).collect::<String>();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "agent/task".to_string()
    } else {
        format!("agent/{slug}")
    }
}

/// Adds a worktree, reusing the branch if it already exists (a card made from an
/// existing PR branch must check that branch out, not fail trying to create it).
pub fn add_worktree(repo: &Path, worktree: &Path, branch: &str) -> Result<PathBuf> {
    if worktree.exists() {
        return Ok(worktree.to_path_buf());
    }
    if let Some(parent) = worktree.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let path = worktree.to_string_lossy().to_string();
    let exists = branch_exists(repo, branch);
    let args: Vec<&str> = if exists {
        vec!["worktree", "add", &path, branch]
    } else {
        vec!["worktree", "add", "-b", branch, &path]
    };

    run(repo, &args)?;
    Ok(worktree.to_path_buf())
}

pub fn branch_exists(repo: &Path, branch: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "--quiet", branch]).is_ok()
}

/// Best effort: a card made from a pull request needs that branch locally, but
/// an offline machine or a missing remote must not block the run.
pub fn fetch_branch(repo: &Path, branch: &str) -> bool {
    run(repo, &["fetch", "origin", &format!("{branch}:{branch}")]).is_ok()
}

pub fn remove_worktree(repo: &Path, worktree: &Path) -> Result<()> {
    if !worktree.exists() {
        return Ok(());
    }
    run(repo, &["worktree", "remove", "--force", &worktree.to_string_lossy()])?;
    Ok(())
}

fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| Error::Invalid(format!("git is not available: {e}")))?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Invalid(format!("git {}: {message}", args.join(" "))));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current_branch(repo: &Path) -> Result<String> {
        run(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
    }

    #[test]
    fn branch_names_are_readable_and_path_safe() {
        assert_eq!(branch_name("Fix the flaky test"), "agent/fix-the-flaky-test");
        assert_eq!(branch_name("Add  /  slashes & spaces!"), "agent/add-slashes-spaces");
        assert_eq!(branch_name("  "), "agent/task");
        assert!(branch_name(&"x".repeat(80)).len() <= "agent/".len() + 40);
    }

    #[test]
    fn a_worktree_is_created_and_removed_in_a_real_repo() {
        let root = std::env::temp_dir().join(format!("agent-board-git-{}", crate::db::new_id()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();

        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["commit", "--allow-empty", "-m", "root"],
        ] {
            run(&repo, &args).unwrap();
        }
        assert!(is_repo(&repo));

        let worktree = root.join("wt");
        add_worktree(&repo, &worktree, "agent/demo").unwrap();
        assert_eq!(current_branch(&worktree).unwrap(), "agent/demo");

        // Adding the same worktree twice is a no-op, not an error: a card that
        // is re-run must land in the tree it already has.
        add_worktree(&repo, &worktree, "agent/demo").unwrap();

        remove_worktree(&repo, &worktree).unwrap();
        assert!(!worktree.exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
