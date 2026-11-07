use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use rusqlite::params;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Db;
use crate::error::{Error, Result};

/// Scratch space for a card: what you hand the agent, and what it hands back.
///
/// Kept beside the app's data rather than in the project, so nothing an agent
/// is given ever turns up as an untracked file in a repo, and everything a card
/// accumulated goes away with the card.
pub const ATTACHED: &str = "tmps-attached";
pub const RESPONSE: &str = "tmps-response";

pub const CHANGED_EVENT: &str = "tmp://changed";

/// Nobody wants a 200MB video pushed through an IPC message as base64.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// One saved file is several filesystem events — created, written, closed — and
/// a copied folder is a burst of them. The lists only ever re-read themselves,
/// so a card is announced at most this often and the burst collapses into one.
const COALESCE: Duration = Duration::from_millis(200);

const PNG_MAGIC: &[u8] = b"\x89PNG";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TmpKind {
    Attached,
    Response,
}

impl TmpKind {
    fn dir(self) -> &'static str {
        match self {
            Self::Attached => ATTACHED,
            Self::Response => RESPONSE,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmpFile {
    pub card_id: String,
    pub kind: TmpKind,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: String,
    /// So the frontend knows whether it can show this one as a thumbnail.
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmpChanged {
    pub card_id: String,
}

pub fn root(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("tmp"))
}

/// A card id is a path segment here, so it is checked rather than trusted: an
/// id carrying a separator or `..` would write anywhere on the disk.
fn card_dir(root: &Path, card_id: &str) -> Result<PathBuf> {
    let usable = !card_id.is_empty()
        && card_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !usable {
        return Err(Error::Invalid(format!("{card_id} is not a card id")));
    }
    Ok(root.join(card_id))
}

/// Every path the frontend hands back has to land inside the store. Canonical
/// on both sides, so neither a symlink nor a `..` gets out of it.
fn within(root: &Path, path: &str) -> Result<PathBuf> {
    let stray = || Error::Invalid("that file is not in the card's tmp store".into());
    let target = PathBuf::from(path).canonicalize().map_err(|_| stray())?;
    let base = root.canonicalize().map_err(|_| stray())?;
    if !target.starts_with(&base) {
        return Err(stray());
    }
    Ok(target)
}

/// Keeps a name a name: no directories, no traversal, never empty.
fn filename(name: &str) -> Result<String> {
    Path::new(name)
        .file_name()
        .and_then(|part| part.to_str())
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .map(str::to_string)
        .ok_or_else(|| Error::Invalid(format!("{name} is not a file name")))
}

/// The same name twice is two files, not one overwriting the other — two
/// screenshots pasted in a row are both worth keeping.
fn unused(directory: &Path, name: &str) -> PathBuf {
    let candidate = directory.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let extension = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();

    (2..)
        .map(|n| directory.join(format!("{stem}-{n}{extension}")))
        .find(|path| !path.exists())
        .expect("an unused name exists")
}

fn mime(name: &str) -> String {
    let extension = Path::new(name)
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" => "text/markdown",
        "txt" | "log" | "diff" | "patch" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn describe(card_id: &str, kind: TmpKind, path: &Path) -> Option<TmpFile> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let name = path.file_name()?.to_str()?.to_string();
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);

    Some(TmpFile {
        card_id: card_id.to_string(),
        kind,
        mime: mime(&name),
        name,
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        modified_at: chrono::DateTime::<chrono::Utc>::from(modified)
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    })
}

fn read_card(root: &Path, card_id: &str) -> Vec<TmpFile> {
    let Ok(directory) = card_dir(root, card_id) else {
        return Vec::new();
    };

    let mut files: Vec<TmpFile> = [TmpKind::Attached, TmpKind::Response]
        .into_iter()
        .flat_map(|kind| {
            fs::read_dir(directory.join(kind.dir()))
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(move |entry| describe(card_id, kind, &entry.path()))
        })
        .collect();

    // Newest last, the order a thumbnail strip reads in.
    files.sort_by(|a, b| a.modified_at.cmp(&b.modified_at).then(a.name.cmp(&b.name)));
    files
}

/// One card's files, or every card's when none is named — the manager panel
/// wants the whole store and would otherwise ask card by card.
pub fn list(root: &Path, card_id: Option<&str>) -> Result<Vec<TmpFile>> {
    if let Some(card_id) = card_id {
        return Ok(read_card(root, card_id));
    }

    let mut all: Vec<TmpFile> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .flat_map(|card| read_card(root, &card))
        .collect();
    all.sort_by(|a, b| a.card_id.cmp(&b.card_id).then(a.modified_at.cmp(&b.modified_at)));
    Ok(all)
}

pub fn add(root: &Path, card_id: &str, kind: TmpKind, name: &str, bytes: &[u8]) -> Result<TmpFile> {
    let directory = card_dir(root, card_id)?.join(kind.dir());
    fs::create_dir_all(&directory)?;

    let path = unused(&directory, &filename(name)?);
    fs::write(&path, bytes)?;
    describe(card_id, kind, &path)
        .ok_or_else(|| Error::Invalid(format!("could not write {name}")))
}

/// What an agent's output may point at that is worth keeping on its card.
/// Source code is deliberately absent: that is the worktree's job, not the store's.
const COLLECTED: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "pdf", "mp4", "webm", "mov", "md",
    "txt", "log", "csv", "json", "html", "diff", "patch",
];

/// Copies files an agent mentioned into the card's response store, so a
/// screenshot it saved to /tmp turns up on the card. A file already there under
/// the same name and size is not copied again — agents repeat paths constantly.
///
/// Returns the paths that are settled, copied or deliberately skipped; a path
/// that does not exist yet is left out so the caller asks again once the agent
/// has actually written it.
pub fn collect(root: &Path, card_id: &str, paths: &[String]) -> Result<Vec<String>> {
    let store = card_dir(root, card_id)?;
    let base = store.canonicalize().ok();
    let mut held = read_card(root, card_id);
    let mut settled = Vec::new();

    for raw in paths {
        let Ok(source) = PathBuf::from(raw).canonicalize() else { continue };
        let Ok(metadata) = fs::metadata(&source) else { continue };
        settled.push(raw.clone());

        let inside = base.as_ref().is_some_and(|base| source.starts_with(base));
        let wanted = source
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| COLLECTED.contains(&e.to_ascii_lowercase().as_str()));
        if inside || !wanted || !metadata.is_file() || metadata.len() > MAX_BYTES {
            continue;
        }
        let Some(name) = source.file_name().and_then(|n| n.to_str()) else { continue };
        if held.iter().any(|file| file.name == name && file.size == metadata.len()) {
            continue;
        }
        held.push(add(root, card_id, TmpKind::Response, name, &fs::read(&source)?)?);
    }
    Ok(settled)
}

#[tauri::command]
pub fn collect_tmp(app: AppHandle, card_id: String, paths: Vec<String>) -> Result<Vec<String>> {
    collect(&root(&app)?, &card_id, &paths)
}

#[tauri::command]
pub fn list_tmp(app: AppHandle, card_id: Option<String>) -> Result<Vec<TmpFile>> {
    let root = root(&app)?;
    fs::create_dir_all(&root)?;
    list(&root, card_id.as_deref())
}

/// Adds a file to a card, its content base64 so anything pasted or picked in
/// the webview arrives intact.
#[tauri::command]
pub fn add_tmp(
    app: AppHandle,
    card_id: String,
    kind: TmpKind,
    name: String,
    contents: String,
) -> Result<TmpFile> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents)
        .map_err(|e| Error::Invalid(format!("could not read the file: {e}")))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Error::Invalid(format!(
            "{name} is larger than {}MB",
            MAX_BYTES / 1024 / 1024
        )));
    }
    add(&root(&app)?, &card_id, kind, &name, &bytes)
}

/// The file's bytes, base64, for showing it without an asset server.
/// The interactive region-capture tool this machine has, aimed at `path`.
///
/// There is no portable way to take a screenshot, so this is a list of the ones
/// people actually have. A machine with none of them says so and points at the
/// clipboard, which works everywhere.
fn screenshot_command(path: &Path) -> Option<Command> {
    let file = path.to_string_lossy().to_string();
    let candidates: Vec<(&str, Vec<String>)> = if cfg!(target_os = "macos") {
        vec![("screencapture", vec!["-i".into(), file])]
    } else if cfg!(windows) {
        Vec::new()
    } else {
        vec![
            ("spectacle", vec!["-bnr".into(), "-o".into(), file.clone()]),
            ("gnome-screenshot", vec!["-a".into(), "-f".into(), file.clone()]),
            ("maim", vec!["-s".into(), file.clone()]),
            ("scrot", vec!["-s".into(), file]),
        ]
    };

    candidates
        .into_iter()
        .find(|(program, _)| super::editor::which(program).is_some())
        .map(|(program, args)| {
            let mut command = Command::new(program);
            command.args(args);
            command
        })
}

/// Takes a screenshot straight onto a card. The capture is interactive — the
/// person picks the region — so it waits far longer than a normal command.
#[tauri::command]
pub fn screenshot_tmp(app: AppHandle, card_id: String) -> Result<TmpFile> {
    let directory = card_dir(&root(&app)?, &card_id)?.join(TmpKind::Attached.dir());
    fs::create_dir_all(&directory)?;
    // Colons are fine on unix and refused on Windows, so the timestamp loses them.
    let stamp = crate::db::now().replace(':', "-");
    let path = unused(&directory, &format!("screenshot-{stamp}.png"));

    let command = screenshot_command(&path).ok_or_else(|| {
        Error::Invalid("no screenshot tool on this machine — paste an image instead".into())
    })?;
    let output = crate::process::run(command, Duration::from_secs(180))?;

    // Cancelling the capture leaves either nothing or an empty file behind.
    let taken = path.metadata().is_ok_and(|file| file.len() > 0);
    if !taken {
        let _ = fs::remove_file(&path);
        return Err(Error::Invalid(if output.ok {
            "no screenshot was taken".into()
        } else {
            format!("the screenshot failed: {}", output.stderr)
        }));
    }

    describe(&card_id, TmpKind::Attached, &path)
        .ok_or_else(|| Error::Invalid("the screenshot could not be read back".into()))
}

/// Reads an image off the system clipboard, using whatever this machine has.
///
/// A paste does not always reach us through the webview: WebKitGTK hands the
/// page a paste event with no file on it, so the image is on the clipboard and
/// nowhere the browser will admit to. macOS and Windows webviews do deliver the
/// file, and the page attaches it before ever asking for this.
fn clipboard_image() -> Option<Vec<u8>> {
    let candidates: Vec<(&str, Vec<&str>)> = vec![
        ("wl-paste", vec!["--no-newline", "--type", "image/png"]),
        ("xclip", vec!["-selection", "clipboard", "-t", "image/png", "-o"]),
    ];

    // Both tools are commonly installed, and the wrong one for the session fails
    // rather than returning nothing, so the answer is the first that yields an
    // image — not the first that exists.
    candidates
        .into_iter()
        .filter(|(program, _)| super::editor::which(program).is_some())
        .find_map(|(program, args)| {
            let mut command = Command::new(program);
            command.args(args);
            let output = crate::process::run(command, Duration::from_secs(10)).ok()?;
            (output.ok && output.bytes.starts_with(PNG_MAGIC)).then_some(output.bytes)
        })
}

/// Attaches the clipboard's image to a card, for a paste the webview swallowed.
#[tauri::command]
pub fn paste_tmp(app: AppHandle, card_id: String) -> Result<TmpFile> {
    let bytes =
        clipboard_image().ok_or_else(|| Error::Invalid("no image on the clipboard".into()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Error::Invalid(format!(
            "the clipboard image is larger than {}MB",
            MAX_BYTES / 1024 / 1024
        )));
    }
    // Colons are fine on unix and refused on Windows, so the timestamp loses them.
    let name = format!("pasted-{}.png", crate::db::now().replace(':', "-"));
    add(&root(&app)?, &card_id, TmpKind::Attached, &name, &bytes)
}

/// Where a card's files live, for the agent that has to read them.
///
/// A card runs in its own worktree and its store is deliberately outside it, so
/// a CLI that confines itself to the working directory cannot open a screenshot
/// it was handed the path to. Nothing comes back for a card with no files: the
/// caller drops the flag rather than pointing a CLI at an empty directory.
#[tauri::command]
pub fn tmp_dir(app: AppHandle, card_id: String) -> Result<Option<String>> {
    let root = root(&app)?;
    if list(&root, Some(&card_id))?.is_empty() {
        return Ok(None);
    }
    Ok(Some(card_dir(&root, &card_id)?.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn read_tmp(app: AppHandle, path: String) -> Result<String> {
    let file = within(&root(&app)?, &path)?;
    if fs::metadata(&file)?.len() > MAX_BYTES {
        return Err(Error::Invalid("that file is too big to show".into()));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(fs::read(file)?))
}

#[tauri::command]
pub fn delete_tmp(app: AppHandle, path: String) -> Result<()> {
    fs::remove_file(within(&root(&app)?, &path)?)?;
    Ok(())
}

/// Everything a card collected, for when the card itself goes.
pub fn clear(app: &AppHandle, card_id: &str) -> Result<()> {
    let directory = card_dir(&root(app)?, card_id)?;
    if directory.exists() {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_tmp(app: AppHandle, card_id: String) -> Result<()> {
    clear(&app, &card_id)
}

/// Shows the file where it actually lives, so it can be dragged elsewhere or
/// opened in something this app knows nothing about.
#[tauri::command]
pub fn reveal_tmp(app: AppHandle, path: String) -> Result<String> {
    let file = within(&root(&app)?, &path)?;
    reveal_path(&file)
}

/// Everything one project's cards are carrying, in the file manager.
///
/// The store is one directory per card, so a project has no directory of its
/// own — this opens the first of its cards that has anything, which is the same
/// place a person would then navigate from.
#[tauri::command]
pub fn reveal_project_tmp(app: AppHandle, db: State<Db>, project_id: String) -> Result<String> {
    let cards: Vec<String> = db.with(|conn| {
        let mut statement =
            conn.prepare("SELECT id FROM tasks WHERE project_id = ?1 ORDER BY created_at")?;
        let ids = statement
            .query_map(params![project_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    })?;

    let root = root(&app)?;
    let directory = cards
        .iter()
        .filter_map(|card| card_dir(&root, card).ok())
        .find(|dir| dir.is_dir())
        .ok_or_else(|| Error::Invalid("this project's cards have no scratch files".into()))?;

    reveal_path(&directory)
}

fn reveal_path(file: &Path) -> Result<String> {
    let directory = if file.is_dir() {
        file.to_path_buf()
    } else {
        file.parent().unwrap_or(file).to_path_buf()
    };

    let (program, args) = if cfg!(target_os = "macos") {
        ("open".to_string(), vec!["-R".to_string(), file.to_string_lossy().to_string()])
    } else if cfg!(windows) {
        ("explorer".to_string(), vec![format!("/select,{}", file.display())])
    } else {
        let opener = ["xdg-open", "nautilus", "dolphin", "thunar", "nemo"]
            .into_iter()
            .find(|candidate| super::editor::which(candidate).is_some())
            .ok_or_else(|| Error::Invalid("no file manager found on this machine".into()))?;
        (opener.to_string(), vec![directory.to_string_lossy().to_string()])
    };

    Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::Invalid(format!("could not open a file manager: {e}")))?;
    Ok(program)
}

/// Which card a changed path belongs to: the store is one directory per card,
/// so it is the first segment under the root.
fn card_of(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()?
        .components()
        .next()?
        .as_os_str()
        .to_str()
        .map(str::to_string)
}

/// Announces changes to the store, however they were made.
///
/// A card's files are as likely to arrive from the agent writing them, or from
/// the file manager the reveal button just opened, as from this app — so the
/// lists on screen follow the directory rather than our own writes.
pub fn watch(app: AppHandle) -> Result<()> {
    let root = root(&app)?;
    fs::create_dir_all(&root)?;

    std::thread::spawn(move || {
        let (sender, events) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(sender) {
            Ok(watcher) => watcher,
            Err(error) => return log::warn!("could not watch the tmp store: {error}"),
        };
        if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
            return log::warn!("could not watch {}: {error}", root.display());
        }

        let mut announced: HashMap<String, Instant> = HashMap::new();
        for event in events.into_iter().flatten() {
            for card in event.paths.iter().filter_map(|path| card_of(&root, path)) {
                let now = Instant::now();
                if announced.get(&card).is_some_and(|last| now - *last < COALESCE) {
                    continue;
                }
                announced.insert(card.clone(), now);
                let _ = app.emit(CHANGED_EVENT, TmpChanged { card_id: card });
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("agent-board-tmp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn files_an_agent_mentions_are_collected_once() {
        let root = scratch("collect");
        let outside = scratch("collect-src");
        let shot = outside.join("shot.png");
        let code = outside.join("main.rs");
        fs::write(&shot, b"png").unwrap();
        fs::write(&code, b"fn main() {}").unwrap();
        let paths = vec![
            shot.to_string_lossy().to_string(),
            code.to_string_lossy().to_string(),
            "/no/such/file.png".to_string(),
        ];

        let settled = collect(&root, "card1", &paths).unwrap();
        assert_eq!(settled.len(), 2, "a missing path is not settled, so it is asked about again");
        let held = list(&root, Some("card1")).unwrap();
        assert_eq!(held.len(), 1, "only the screenshot, not source code");
        assert_eq!(held[0].kind, TmpKind::Response);

        collect(&root, "card1", &paths).unwrap();
        collect(&root, "card1", &[held[0].path.clone()]).unwrap();
        assert_eq!(list(&root, Some("card1")).unwrap().len(), 1, "nothing is copied twice");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_card_keeps_what_it_was_given_and_what_came_back() {
        let root = scratch("roundtrip");
        add(&root, "card1", TmpKind::Attached, "shot.png", b"png").unwrap();
        add(&root, "card1", TmpKind::Response, "report.md", b"# hi").unwrap();
        add(&root, "card2", TmpKind::Attached, "other.txt", b"x").unwrap();

        let mine = list(&root, Some("card1")).unwrap();
        assert_eq!(mine.len(), 2);

        let shot = mine.iter().find(|file| file.name == "shot.png").unwrap();
        assert_eq!(shot.mime, "image/png");
        assert_eq!(shot.kind, TmpKind::Attached);
        assert!(shot.path.contains(ATTACHED));

        let report = mine.iter().find(|file| file.name == "report.md").unwrap();
        assert_eq!(report.kind, TmpKind::Response);
        assert!(report.path.contains(RESPONSE));

        assert_eq!(list(&root, None).unwrap().len(), 3, "the whole store in one call");
    }

    #[test]
    fn the_same_name_twice_is_two_files() {
        let root = scratch("names");
        let first = add(&root, "card1", TmpKind::Attached, "paste.png", b"a").unwrap();
        let second = add(&root, "card1", TmpKind::Attached, "paste.png", b"b").unwrap();

        assert_eq!(first.name, "paste.png");
        assert_eq!(second.name, "paste-2.png");
    }

    #[test]
    fn a_changed_path_names_the_card_it_belongs_to() {
        let root = Path::new("/data/tmp");
        assert_eq!(
            card_of(root, &root.join("card1").join(ATTACHED).join("shot.png")),
            Some("card1".to_string()),
        );
        assert_eq!(card_of(root, Path::new("/elsewhere/x")), None);
    }

    #[test]
    fn nothing_writes_or_reads_outside_the_store() {
        let root = scratch("escape");
        assert!(add(&root, "../etc", TmpKind::Attached, "x", b"x").is_err());

        // A name carrying a path is flattened to its last part rather than
        // refused: it is still one file, and it still lands under the card.
        let flattened = add(&root, "card1", TmpKind::Attached, "../../x.txt", b"x").unwrap();
        assert_eq!(flattened.name, "x.txt");
        assert!(PathBuf::from(&flattened.path).starts_with(&root));
        assert!(add(&root, "card1", TmpKind::Attached, "..", b"x").is_err());

        add(&root, "card1", TmpKind::Attached, "kept.txt", b"x").unwrap();
        let outside = std::env::temp_dir().join("agent-board-outside.txt");
        fs::write(&outside, b"secret").unwrap();
        assert!(within(&root, outside.to_str().unwrap()).is_err());
    }
}
