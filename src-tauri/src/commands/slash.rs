use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::commands::projects;
use crate::db::Db;
use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// What you type: `/infra-llm-plan`, or `/plugin:name` for a plugin's.
    pub name: String,
    /// project | user | plugin | builtin
    pub scope: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
}

/// The few built-ins every version has, for when the CLI cannot be asked.
const BUILTINS: &[(&str, &str, Option<&str>)] = &[
    ("/init", "Initialize a CLAUDE.md file with codebase documentation", None),
    ("/review", "Review a pull request", Some("[pr number]")),
    ("/security-review", "Complete a security review of the pending changes", None),
    ("/remote-control", "Control this session from your phone or claude.ai/code", None),
];

/// How long the CLI's own answer is reused. Asking it means starting a session,
/// which takes a couple of seconds; files on disk are still re-read every call.
const CLI_FRESH: Duration = Duration::from_secs(60);
const CLI_DEADLINE: Duration = Duration::from_secs(20);

/// Every slash command the terminal would offer in this project.
///
/// Three sources, merged by name: the CLI itself, asked over its control
/// protocol for the commands it has loaded (skills, plugins, built-ins, MCP
/// prompts — exactly its list); the interactive-only built-ins such as
/// /remote-control, which a headless session leaves out, read from the
/// installed CLI so they follow its version; and the command and skill
/// directories, so something added on disk shows up before the CLI's answer
/// is refreshed, and the list still works if the CLI cannot be asked.
#[tauri::command]
pub async fn list_slash_commands(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<SlashCommand>> {
    let project = match project_id {
        Some(id) => Some(PathBuf::from(db.with(|conn| projects::get(conn, &id))?.path)),
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let mut found = cli_commands(project.as_deref());
        found.extend(interactive_commands());
        found.extend(discover(home.as_deref(), project.as_deref()));
        dedup_sorted(found)
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(e.to_string()))
}

fn dedup_sorted(mut found: Vec<SlashCommand>) -> Vec<SlashCommand> {
    let mut seen = std::collections::HashSet::new();
    found.retain(|command| seen.insert(command.name.clone()));
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn cli_commands(project: Option<&Path>) -> Vec<SlashCommand> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Instant, Vec<SlashCommand>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = project.map(Path::to_path_buf).unwrap_or_default();

    if let Some((at, list)) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
        if at.elapsed() < CLI_FRESH {
            return list;
        }
    }
    let Some(list) = ask_cli(project) else {
        // A failed ask keeps whatever it last said rather than dropping to nothing.
        return cache.lock().ok().and_then(|c| c.get(&key).map(|e| e.1.clone())).unwrap_or_default();
    };
    if let Ok(mut c) = cache.lock() {
        c.insert(key, (Instant::now(), list.clone()));
    }
    list
}

/// Starts a headless session and sends only the SDK's `initialize` request,
/// whose reply lists the loaded commands. No prompt is sent, so no model call
/// is made; hooks and MCP servers are kept off so asking has no side effects.
fn ask_cli(project: Option<&Path>) -> Option<Vec<SlashCommand>> {
    let mut command = Command::new("claude");
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--settings",
            r#"{"disableAllHooks":true}"#,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = project.filter(|dir| dir.is_dir()) {
        command.current_dir(dir);
    }
    let mut child = command.spawn().ok()?;

    let mut stdin = child.stdin.take()?;
    let request = r#"{"type":"control_request","request_id":"agent-board-commands","request":{"subtype":"initialize"}}"#;
    let _ = writeln!(stdin, "{request}");
    let stdout = child.stdout.take()?;

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
            if line.contains("agent-board-commands") && line.contains("control_response") {
                let _ = sender.send(line);
                return;
            }
        }
    });
    let reply = receiver.recv_timeout(CLI_DEADLINE).ok();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    let json: Value = serde_json::from_str(&reply?).ok()?;
    let listed = json.pointer("/response/response/commands")?.as_array()?;
    Some(listed.iter().filter_map(from_cli).collect())
}

fn from_cli(value: &Value) -> Option<SlashCommand> {
    let name = value.get("name")?.as_str()?.trim_start_matches('/');
    // Double-underscore names are the CLI's own plumbing, not for typing.
    if name.is_empty() || name.starts_with("__") {
        return None;
    }
    let text = |key: &str| {
        value.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
    };
    let mut description = text("description").map(str::to_string);
    let mut scope = if name.contains(':') { "plugin" } else { "builtin" };
    // The CLI tags where a command came from on the end of its description.
    for (tag, tagged) in [(" (user)", "user"), (" (project)", "project")] {
        if let Some(stripped) = description.as_deref().and_then(|d| d.strip_suffix(tag)) {
            description = Some(stripped.to_string());
            scope = tagged;
        }
    }
    Some(SlashCommand {
        name: format!("/{name}"),
        scope: scope.into(),
        description,
        argument_hint: text("argumentHint").map(str::to_string),
    })
}

/// Reads the CLI's interactive built-ins in the background at start-up, so the
/// first `/` typed in a card does not wait on scanning the binary.
pub fn warm() {
    std::thread::spawn(|| {
        interactive_commands();
    });
}

/// Built-ins that only exist in the interactive terminal (/remote-control,
/// /resume, /permissions…), which a headless session does not report. They
/// are read out of the installed CLI itself, so a new version brings its own
/// list; the scan is cached per binary and only redone when it changes.
fn interactive_commands() -> Vec<SlashCommand> {
    static CACHE: OnceLock<Mutex<Option<(PathBuf, SystemTime, Vec<SlashCommand>)>>> = OnceLock::new();
    let Some(binary) = which("claude").and_then(|path| path.canonicalize().ok()) else {
        return Vec::new();
    };
    let modified = std::fs::metadata(&binary).and_then(|m| m.modified()).ok();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((path, at, list)) = cache.lock().ok().and_then(|c| c.clone()) {
        if path == binary && Some(at) == modified {
            return list;
        }
    }
    let list = std::fs::read(&binary).map(|bytes| scan_interactive(&bytes)).unwrap_or_default();
    if let (Ok(mut c), Some(at)) = (cache.lock(), modified) {
        *c = Some((binary, at, list.clone()));
    }
    list
}

/// Interactive commands are declared as `type:"local-jsx",name:"…"` objects in
/// the CLI's bundle. A description is taken when it is a plain string; hidden
/// ones are skipped.
fn scan_interactive(bytes: &[u8]) -> Vec<SlashCommand> {
    const MARK: &[u8] = b"type:\"local-jsx\",name:\"";
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = find(&bytes[at..], MARK) {
        let start = at + offset + MARK.len();
        at = start;
        let Some(end) = bytes[start..].iter().position(|&b| b == b'"').map(|e| start + e) else {
            break;
        };
        let name = String::from_utf8_lossy(&bytes[start..end]).to_string();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            continue;
        }
        let window = &bytes[end..(end + 600).min(bytes.len())];
        let window = window.split(|&b| b == b'}').next().unwrap_or(window);
        let window = String::from_utf8_lossy(window);
        if window.contains("isHidden:!0") {
            continue;
        }
        let description = window
            .split("description:\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        found.push(SlashCommand {
            name: format!("/{name}"),
            scope: "builtin".into(),
            description,
            argument_hint: None,
        });
    }
    // The same command is often declared twice (one per variant); keep the
    // first one that carries a description.
    found.sort_by(|a, b| a.name.cmp(&b.name).then(b.description.is_some().cmp(&a.description.is_some())));
    found.dedup_by(|a, b| a.name == b.name);
    found
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    memchr::memmem::find(haystack, needle)
}

fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|path| path.is_file())
}

fn discover(home: Option<&Path>, project: Option<&Path>) -> Vec<SlashCommand> {
    let mut found = Vec::new();

    // Project first: on a name clash the CLI runs the project's, and the
    // dedup below keeps the first of each name.
    if let Some(project) = project {
        let claude = project.join(".claude");
        commands(&claude.join("commands"), "project", None, &mut found);
        skills(&claude.join("skills"), "project", None, &mut found);
    }
    if let Some(home) = home {
        let claude = home.join(".claude");
        commands(&claude.join("commands"), "user", None, &mut found);
        skills(&claude.join("skills"), "user", None, &mut found);
        for (name, root) in enabled_plugins(&claude, project) {
            plugin(&root, &name, &mut found);
        }
    }
    for (name, description, hint) in BUILTINS {
        found.push(SlashCommand {
            name: (*name).into(),
            scope: "builtin".into(),
            description: Some((*description).into()),
            argument_hint: hint.map(Into::into),
        });
    }
    dedup_sorted(found)
}

/// `commands/*.md`, recursively. Subdirectories organise commands without
/// changing their names, as the CLI treats them.
fn commands(root: &Path, scope: &str, prefix: Option<&str>, found: &mut Vec<SlashCommand>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let file = entry.file_name().to_string_lossy().to_string();
            let Some(stem) = file.strip_suffix(".md") else { continue };
            let meta = frontmatter(&path);
            found.push(entry_for(prefix, stem, scope, &meta));
        }
    }
}

/// `skills/<name>/SKILL.md`. A skill marked `user-invocable: false` is for the
/// model only and has no slash command.
fn skills(root: &Path, scope: &str, prefix: Option<&str>, found: &mut Vec<SlashCommand>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let file = entry.path().join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let meta = frontmatter(&file);
        if meta.get("user-invocable").map(String::as_str) == Some("false") {
            continue;
        }
        let dir = entry.file_name().to_string_lossy().to_string();
        let name = meta.get("name").cloned().unwrap_or(dir);
        found.push(entry_for(prefix, &name, scope, &meta));
    }
}

fn entry_for(
    prefix: Option<&str>,
    name: &str,
    scope: &str,
    meta: &BTreeMap<String, String>,
) -> SlashCommand {
    SlashCommand {
        name: match prefix {
            Some(plugin) => format!("/{plugin}:{name}"),
            None => format!("/{name}"),
        },
        scope: scope.to_string(),
        description: meta.get("description").cloned(),
        argument_hint: meta.get("argument-hint").cloned(),
    }
}

/// A plugin's commands and skills, from its default directories and any extra
/// paths its manifest names.
fn plugin(root: &Path, fallback: &str, found: &mut Vec<SlashCommand>) {
    let manifest: Value = std::fs::read_to_string(root.join(".claude-plugin/plugin.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let name = manifest.get("name").and_then(Value::as_str).unwrap_or(fallback).to_string();

    let paths = |key: &str| -> Vec<PathBuf> {
        let mut dirs = vec![root.join(key)];
        match manifest.get(key) {
            Some(Value::String(path)) => dirs.push(root.join(path)),
            Some(Value::Array(list)) => {
                dirs.extend(list.iter().filter_map(Value::as_str).map(|path| root.join(path)))
            }
            _ => {}
        }
        dirs.sort();
        dirs.dedup();
        dirs
    };
    for dir in paths("commands") {
        commands(&dir, "plugin", Some(&name), found);
    }
    for dir in paths("skills") {
        skills(&dir, "plugin", Some(&name), found);
    }
}

/// Installed plugins that are switched on, as (name, install directory). The
/// switch can sit in the user's settings or the project's, the project winning.
fn enabled_plugins(claude: &Path, project: Option<&Path>) -> Vec<(String, PathBuf)> {
    let mut enabled: BTreeMap<String, bool> = BTreeMap::new();
    let mut settings = vec![claude.join("settings.json")];
    if let Some(project) = project {
        settings.push(project.join(".claude/settings.json"));
        settings.push(project.join(".claude/settings.local.json"));
    }
    for file in settings {
        let Some(map) = read_json(&file)
            .and_then(|json| json.get("enabledPlugins").cloned())
            .and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        for (id, on) in map {
            enabled.insert(id, on.as_bool().unwrap_or(false));
        }
    }

    let installed = read_json(&claude.join("plugins/installed_plugins.json"))
        .and_then(|json| json.get("plugins").cloned())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    installed
        .into_iter()
        .filter(|(id, _)| enabled.get(id).copied().unwrap_or(false))
        .filter_map(|(id, installs)| {
            let path = installs
                .as_array()?
                .iter()
                .rev()
                .find_map(|install| install.get("installPath")?.as_str())?
                .to_string();
            let name = id.split('@').next().unwrap_or(&id).to_string();
            Some((name, PathBuf::from(path)))
        })
        .collect()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The leading `---` block as flat key/value pairs, with the YAML forms these
/// files actually use: quoted values and `>-` / `|` blocks over indented lines.
fn frontmatter(path: &Path) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return fields };
    let Some(block) = text.strip_prefix("---").and_then(|rest| rest.split("\n---").next()) else {
        return fields;
    };

    let mut current: Option<(String, Vec<String>)> = None;
    let finish = |entry: Option<(String, Vec<String>)>, fields: &mut BTreeMap<String, String>| {
        if let Some((key, parts)) = entry {
            let value = parts.join(" ").trim().to_string();
            if !value.is_empty() {
                fields.insert(key, value);
            }
        }
    };

    for line in block.lines() {
        let continuation = line.starts_with(' ') || line.starts_with('\t');
        if continuation {
            if let Some((_, parts)) = current.as_mut() {
                parts.push(line.trim().to_string());
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        finish(current.take(), &mut fields);
        let value = value.trim();
        let value = if matches!(value, ">" | ">-" | "|" | "|-") { "" } else { value };
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        current = Some((key.trim().to_string(), vec![value.to_string()]));
    }
    finish(current, &mut fields);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn lists_what_the_agent_would_accept() {
        let root = std::env::temp_dir().join(format!("agent-board-slash-{}", crate::db::new_id()));
        let home = root.join("home");
        let project = root.join("project");
        let claude = home.join(".claude");

        write(
            &claude.join("commands/plan.md"),
            "---\ndescription: Plan it out\nargument-hint: <path>\n---\nbody\n",
        );
        write(&claude.join("commands/infra/deploy.md"), "no frontmatter here");
        write(&claude.join("commands/notes.txt"), "not a command");
        write(
            &claude.join("skills/tidy/SKILL.md"),
            "---\nname: tidy\ndescription: >-\n  Cut dead code\n  and nesting.\n---\n",
        );
        write(
            &claude.join("skills/hidden/SKILL.md"),
            "---\nname: hidden\nuser-invocable: false\n---\n",
        );
        write(&project.join(".claude/commands/plan.md"), "---\ndescription: \"Project plan\"\n---\n");

        let on = root.join("plugins/design");
        let off = root.join("plugins/off");
        write(&on.join(".claude-plugin/plugin.json"), r#"{"name":"design"}"#);
        write(&on.join("skills/polish/SKILL.md"), "---\nname: polish\nargument-hint: \"[target]\"\n---\n");
        write(&on.join("commands/audit.md"), "audit");
        write(&off.join("skills/nope/SKILL.md"), "---\nname: nope\n---\n");
        write(
            &claude.join("plugins/installed_plugins.json"),
            &format!(
                r#"{{"plugins":{{"design@m":[{{"installPath":"{}"}}],"off@m":[{{"installPath":"{}"}}]}}}}"#,
                on.display(),
                off.display()
            ),
        );
        write(&claude.join("settings.json"), r#"{"enabledPlugins":{"design@m":true,"off@m":false}}"#);

        let found = discover(Some(&home), Some(&project));
        let names: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "/deploy",
                "/design:audit",
                "/design:polish",
                "/init",
                "/plan",
                "/remote-control",
                "/review",
                "/security-review",
                "/tidy"
            ],
            "subdirectories do not namespace, hidden skills and disabled plugins are left out"
        );

        let by = |name: &str| found.iter().find(|c| c.name == name).unwrap();
        assert_eq!(by("/plan").description.as_deref(), Some("Project plan"), "the project's wins");
        assert_eq!(by("/plan").scope, "project");
        assert_eq!(by("/tidy").description.as_deref(), Some("Cut dead code and nesting."));
        assert_eq!(by("/design:polish").argument_hint.as_deref(), Some("[target]"));
        assert_eq!(by("/deploy").description, None, "frontmatter is optional");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_clis_own_list_is_read_with_its_source_tags() {
        let reply = serde_json::json!([
            {"name": "infra-llm-plan", "description": "Plan it (user)", "argumentHint": "<path>"},
            {"name": "impeccable:impeccable", "description": "(impeccable) Design", "argumentHint": ""},
            {"name": "compact", "description": "Summarize", "argumentHint": "<instructions>"},
            {"name": "__remote-workflow", "description": "plumbing"}
        ]);
        let listed: Vec<_> = reply.as_array().unwrap().iter().filter_map(from_cli).collect();
        assert_eq!(listed.len(), 3, "plumbing is left out");
        assert_eq!(listed[0].name, "/infra-llm-plan");
        assert_eq!(listed[0].scope, "user");
        assert_eq!(listed[0].description.as_deref(), Some("Plan it"));
        assert_eq!(listed[1].scope, "plugin");
        assert_eq!(listed[1].argument_hint, None, "an empty hint is no hint");
        assert_eq!(listed[2].scope, "builtin");
    }

    #[test]
    fn interactive_built_ins_are_read_out_of_the_cli_bundle() {
        let bundle = br#"x={type:"local-jsx",name:"remote-control",aliases:["rc"],get description(){return a()}};
            y={type:"local-jsx",name:"remote-control",aliases:["rc"],description:"Control this session from your phone"};
            z={type:"local-jsx",name:"pro-trial-expired",isHidden:!0,description:"internal"};
            w={type:"local-jsx",name:"resume",description:"Resume a previous conversation"};"#;
        let found = scan_interactive(bundle);
        let names: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["/remote-control", "/resume"], "hidden ones are skipped, twins merged");
        assert_eq!(found[0].description.as_deref(), Some("Control this session from your phone"));
    }

    #[test]
    fn missing_directories_are_not_an_error() {
        let found = discover(Some(Path::new("/nope/home")), Some(Path::new("/nope/project")));
        assert!(found.iter().all(|command| command.scope == "builtin"));
    }
}
