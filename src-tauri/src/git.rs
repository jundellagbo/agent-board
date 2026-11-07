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

/// The repository's local branches, most recently committed to first — the ones
/// someone is likely to still be working on.
pub fn branches(repo: &Path) -> Result<Vec<String>> {
    let listed = run(
        repo,
        &["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads"],
    )?;
    Ok(listed.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect())
}

/// A generated branch name the repository is not already using.
///
/// `add_worktree` checks an existing branch out rather than failing on it, which
/// is right for a card made from a pull request and wrong for a name we invented
/// — two cards with the same title would land on one branch, each undoing the
/// other.
pub fn unused_branch(repo: &Path, title: &str) -> String {
    let base = branch_name(title);
    if !branch_exists(repo, &base) {
        return base;
    }
    (2..100)
        .map(|suffix| format!("{base}-{suffix}"))
        .find(|name| !branch_exists(repo, name))
        .unwrap_or(base)
}

/// Puts the repository itself on `branch`, creating it if it is not there yet.
///
/// For the card that runs in the project directory rather than a worktree of its
/// own. Uncommitted work is git's problem to judge: it carries changes across
/// where it safely can and refuses outright where it cannot, which is the
/// behaviour anyone switching branches by hand already expects.
pub fn checkout(repo: &Path, branch: &str) -> Result<()> {
    if branch_exists(repo, branch) {
        run(repo, &["checkout", branch])?;
    } else {
        run(repo, &["checkout", "-b", branch])?;
    }
    Ok(())
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

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// None for a detached HEAD.
    pub branch: Option<String>,
    /// The repository's own checkout, which git will not remove.
    pub main: bool,
}

pub fn worktrees(repo: &Path) -> Result<Vec<Worktree>> {
    Ok(parse_worktrees(&run(repo, &["worktree", "list", "--porcelain"])?))
}

fn parse_worktrees(porcelain: &str) -> Vec<Worktree> {
    porcelain
        .split("\n\n")
        .enumerate()
        .filter_map(|(index, block)| {
            let mut path = None;
            let mut branch = None;
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("worktree ") {
                    path = Some(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("branch ") {
                    branch = Some(rest.trim_start_matches("refs/heads/").to_string());
                }
            }
            path.map(|path| Worktree { path, branch, main: index == 0 })
        })
        .collect()
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
    fn worktree_porcelain_is_read_with_branches() {
        let listed = parse_worktrees(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt\nHEAD def\ndetached\n\nworktree /wt2\nHEAD 123\nbranch refs/heads/agent/x",
        );
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0], Worktree { path: "/repo".into(), branch: Some("main".into()), main: true });
        assert_eq!(listed[1].branch, None);
        assert_eq!(listed[2].branch.as_deref(), Some("agent/x"));
        assert!(!listed[2].main);
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

        // A card that wants no worktree of its own still gets its branch, in the
        // repository itself — created the first time, switched to after that.
        checkout(&repo, "agent/in-place").unwrap();
        assert_eq!(current_branch(&repo).unwrap(), "agent/in-place");
        checkout(&repo, "main").unwrap();
        checkout(&repo, "agent/in-place").unwrap();
        assert_eq!(current_branch(&repo).unwrap(), "agent/in-place");
        run(&repo, &["checkout", "main"]).unwrap();

        // The branch the worktree is on is one a card could be pointed at.
        assert!(branches(&repo).unwrap().contains(&"agent/demo".to_string()));

        // Two cards with the same title must not land on one branch.
        assert_eq!(unused_branch(&repo, "demo"), "agent/demo-2");
        assert_eq!(unused_branch(&repo, "something else"), "agent/something-else");

        let listed = worktrees(&repo).unwrap();
        assert!(listed.iter().any(|w| w.branch.as_deref() == Some("agent/demo") && !w.main));

        remove_worktree(&repo, &worktree).unwrap();
        assert!(!worktree.exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
