use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// The `claude mcp add` arguments, minus the scope, which the caller adds.
    pub args: &'static [&'static str],
    pub docs: &'static str,
}

/// Servers worth one click. Everything here is installed through the agent CLI's
/// own config, so the board never becomes a second place MCP state can drift.
pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        key: "chrome-devtools",
        name: "Chrome DevTools",
        description: "Drive and inspect a real Chrome: screenshots, console, network, tracing.",
        args: &["chrome-devtools", "--", "npx", "-y", "chrome-devtools-mcp@latest"],
        docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    },
    CatalogEntry {
        key: "figma",
        name: "Figma Dev Mode",
        description: "Read designs from the Figma desktop app. Needs Dev Mode's local server.",
        args: &["--transport", "sse", "figma", "http://127.0.0.1:3845/sse"],
        docs: "https://help.figma.com/hc/en-us/articles/32132100833559",
    },
    CatalogEntry {
        key: "playwright",
        name: "Playwright",
        description: "Browser automation over an accessibility tree — no screenshots needed.",
        args: &["playwright", "--", "npx", "-y", "@playwright/mcp@latest"],
        docs: "https://github.com/microsoft/playwright-mcp",
    },
    CatalogEntry {
        key: "context7",
        name: "Context7",
        description: "Up-to-date documentation and code examples for libraries.",
        args: &["context7", "--", "npx", "-y", "@upstash/context7-mcp"],
        docs: "https://github.com/upstash/context7",
    },
    CatalogEntry {
        key: "sequential-thinking",
        name: "Sequential Thinking",
        description: "A scratchpad for long multi-step reasoning.",
        args: &[
            "sequential-thinking",
            "--",
            "npx",
            "-y",
            "@modelcontextprotocol/server-sequential-thinking",
        ],
        docs: "https://github.com/modelcontextprotocol/servers",
    },
    CatalogEntry {
        key: "fetch",
        name: "Fetch",
        description: "Fetch a URL and convert it to markdown.",
        args: &["fetch", "--", "npx", "-y", "@modelcontextprotocol/server-fetch"],
        docs: "https://github.com/modelcontextprotocol/servers",
    },
];

pub fn find(key: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| entry.key == key)
}

/// The server name the agent CLI knows it by: the first argument that is not a
/// flag or a flag's value.
pub fn server_name(entry: &CatalogEntry) -> &'static str {
    let mut args = entry.args.iter();
    while let Some(arg) = args.next() {
        if arg.starts_with("--") {
            args.next();
            continue;
        }
        return arg;
    }
    entry.key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_has_a_usable_server_name() {
        for entry in CATALOG {
            let name = server_name(entry);
            assert!(!name.starts_with("--"), "{}: {name} is a flag", entry.key);
            assert!(!name.is_empty());
        }
        assert_eq!(server_name(find("figma").unwrap()), "figma");
        assert_eq!(server_name(find("chrome-devtools").unwrap()), "chrome-devtools");
    }
}
