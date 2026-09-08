use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::Result;

/// Files above this are almost always generated or binary, and blow the index up
/// for nothing.
const MAX_BYTES: u64 = 512 * 1024;

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    "vendor",
    "__pycache__",
    ".venv",
];

/// The files worth indexing. In a repo, git already knows — it respects
/// .gitignore for free; elsewhere we walk and skip the usual noise.
pub fn collect(root: &Path) -> Vec<PathBuf> {
    tracked_files(root).unwrap_or_else(|| walk(root))
}

fn tracked_files(root: &Path) -> Option<Vec<PathBuf>> {
    let output = Command::new("git")
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    Some(
        String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|line| !line.is_empty())
            .map(|line| root.join(line))
            .collect(),
    )
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(path);
                }
            } else {
                found.push(path);
            }
        }
    }
    found
}

/// Reads a file if it is text we can index. A NUL byte is the cheap, reliable
/// signal that it is not — extension lists never keep up.
pub fn read_text(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub fn relative(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_and_oversized_files_are_left_out() {
        let dir = std::env::temp_dir().join(format!("agent-board-index-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).unwrap();

        let text = dir.join("readme.md");
        std::fs::write(&text, "hello board").unwrap();
        let binary = dir.join("logo.png");
        std::fs::write(&binary, [0x89, 0x50, 0x00, 0x0d]).unwrap();
        let huge = dir.join("bundle.js");
        std::fs::write(&huge, "x".repeat((MAX_BYTES + 1) as usize)).unwrap();

        assert_eq!(read_text(&text).as_deref(), Some("hello board"));
        assert!(read_text(&binary).is_none(), "a NUL byte means binary");
        assert!(read_text(&huge).is_none(), "oversized files are skipped");

        let found = collect(&dir);
        assert_eq!(found.len(), 3, "collection is separate from filtering");
        std::fs::remove_dir_all(&dir).ok();
    }
}
