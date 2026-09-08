# Agent Board

A desktop Kanban board that runs coding agents. Columns carry a board type plus
the skill and command an agent runs for cards in them, so a card claims itself,
runs in its own git worktree, and moves to the column its exit code designates.

Next.js (static export) inside a Tauri v2 shell; Rust owns the terminal, git,
SQLite, indexing and notifications.

## Run it in development

```bash
npm install
npm run tauri dev
```

The window opens against a live Next dev server, so frontend edits hot-reload.
Data lives in a SQLite file under the OS app-data directory
(`~/.local/share/dev.agentboard.app/agent-board.db` on Linux), which is why
boards survive a restart.

## Build an installer

`npm run tauri build` produces installers **for the machine it runs on** — a
webview app cannot be usefully cross-compiled. Output lands in
`src-tauri/target/release/bundle/`.

| Host | You get |
| --- | --- |
| Linux | `.deb`, `.rpm`, `.AppImage` |
| Windows | `.exe` (NSIS, per-user) and `.msi` |
| macOS | `.app` and `.dmg` |

```bash
npm run tauri build                    # everything the host can make
npm run tauri build -- --bundles deb   # just one
```

Installing the Linux build:

```bash
sudo dpkg -i "src-tauri/target/release/bundle/deb/Agent Board_0.1.0_amd64.deb"
agent-board          # or launch "Agent Board" from your app menu
```

AppImage downloads `linuxdeploy` the first time it runs, so that target needs
network access.

## All three platforms at once

`.github/workflows/release.yml` builds on ubuntu-22.04, windows-latest and both
macOS architectures, then opens a draft release with every installer attached.
It runs when a tag matching `v*` is pushed, so it needs this checkout to be a
git repository with a GitHub remote — it is not one yet. Initialise it, push it,
and tag a version; the draft release appears under the repo's Releases tab a few
minutes later.

### Build requirements

- Rust (stable) and Node 20+ everywhere.
- Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libxdo-dev`.
- Windows: the WebView2 runtime (present on Windows 11, bundled by the installer).
- macOS: Xcode command line tools.

## Checks

```bash
npm run verify   # typecheck, lint, web tests, cargo check, cargo test
```
