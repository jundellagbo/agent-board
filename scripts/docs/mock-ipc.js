// Stands in for the Rust side when the UI is opened in a plain browser, so the
// documentation screenshots show realistic sample data instead of the
// "unavailable outside the desktop app" errors — and never anyone's real
// projects. Pass it as a page init script (e.g. chrome-devtools navigate_page
// `initScript`) against `next dev`. xterm cannot paint in a background tab,
// so terminal output only shows with the tab in front.
(() => {
  const now = "2026-11-19T09:30:00.000Z";
  const stamp = { createdAt: now, updatedAt: now };
  const root = "/home/dev/code/storefront";

  const org = { id: "org1", name: "Acme Studio", position: 0, ...stamp };
  const project = {
    id: "p1", orgId: "org1", name: "storefront", path: root, agentId: "a1", isGit: true,
    useWorktrees: true, autoRun: true, indexStatus: "indexed", indexedAt: now, position: 0, ...stamp,
  };
  const other = { ...project, id: "p2", name: "marketing-site", path: "/home/dev/code/marketing-site", autoRun: false, position: 1 };

  const group = (id, name, boardType, position, extra = {}) => ({
    id, projectId: "p1", name, boardType, position, autoRun: false, plans: false, skills: [],
    command: null, prompt: null, agentId: null, model: null, runningGroupId: null,
    successGroupId: null, failureGroupId: null, wipLimit: null, color: null, ...stamp, ...extra,
  });
  const groups = [
    group("g1", "Todo", "todo", 0),
    group("g2", "In progress", "in_progress", 1, { autoRun: true, plans: true, successGroupId: "g3", failureGroupId: "g1", wipLimit: 3 }),
    group("g3", "Review", "review", 2, { autoRun: true, skills: ["infra-llm-review"], successGroupId: "g4", failureGroupId: "g2" }),
    group("g4", "Done", "done", 3),
  ];

  let n = 0;
  const task = (groupId, title, runState = "idle", extra = {}) => ({
    id: `t${++n}`, projectId: "p1", groupId, title, body: null, plan: null, position: n,
    agentId: null, model: null, remote: false, useWorktree: true, githubUrl: null, githubKind: null,
    githubNumber: null, branch: null, worktreePath: null, runState, lastRunId: null, ...stamp, ...extra,
  });
  const tasks = [
    task("g1", "Add Apple Pay to checkout", "idle", { body: "Use the existing Stripe integration. Plan: see planner/checkout.md" }),
    task("g1", "Fix cart badge not updating after remove", "idle", { githubUrl: "https://github.com/acme/storefront/issues/142", githubKind: "issue", githubNumber: 142 }),
    task("g1", "Write product page skeleton loaders"),
    task("g2", "Migrate product search to the new index", "running", { branch: "search-index", worktreePath: `${root}/.worktrees/search-index` }),
    task("g2", "Lazy-load reviews widget", "needs_approval", { branch: "lazy-reviews" }),
    task("g3", "Coupon codes are case-insensitive", "running", { branch: "coupon-case" }),
    task("g4", "Upgrade Next.js to 15.5", "done"),
    task("g4", "Add order confirmation email", "done"),
  ];

  const agents = [
    { id: "a1", name: "Claude Code", command: "claude --model {model} \"$AGENT_BOARD_PROMPT\"", env: "", model: "claude-opus-5-5", isDefault: true, ...stamp },
    { id: "a2", name: "Claude Code (fast)", command: "claude --model {model} \"$AGENT_BOARD_PROMPT\"", env: "", model: "claude-haiku-5-5", isDefault: false, ...stamp },
  ];

  const planDir = "/home/dev/.local/share/dev.agentboard.app/tmp/planner";
  const plans = {
    "checkout.md": "# Apple Pay at checkout\n\n## Goal\nLet shoppers pay with Apple Pay on Safari and iOS.\n\n## Steps\n- [x] Enable the Apple Pay domain in Stripe\n- [ ] Add `PaymentRequestButton` to `CheckoutForm.tsx`\n- [ ] Fall back to card entry when unsupported\n- [ ] E2E test on Safari\n\n| Browser | Supported |\n|---|---|\n| Safari 17+ | Yes |\n| Chrome | Google Pay instead |\n\n> Keep the card form as the default path.\n",
    "search-migration.md": "# Search migration\n\nMove product search to the new index.\n",
    "release-notes.md": "# Release notes draft\n",
  };
  const planFile = (name) => ({ name, path: `${planDir}/${name}`, size: plans[name].length, modifiedAt: now });

  const callbacks = new Map();
  let nextCallback = 1;
  const listeners = new Map();
  const emit = (event, payload) =>
    (listeners.get(event) ?? []).forEach((id) => callbacks.get(id)?.({ event, id, payload }));

  const encoder = new TextEncoder();
  const base64 = (text) => btoa(String.fromCharCode(...encoder.encode(text)));
  const RESUME =
    "\x1b[1m Resume Session\x1b[0m\r\n\r\n" +
    "\x1b[36m❯\x1b[0m 1. Apple Pay checkout plan            \x1b[2m2 hours ago · 41 messages · checkout\x1b[0m\r\n" +
    "  2. Migrate product search             \x1b[2myesterday · 128 messages · search-index\x1b[0m\r\n" +
    "  3. Fix cart badge after remove        \x1b[2m3 days ago · 17 messages · main\x1b[0m\r\n\r\n" +
    "\x1b[2m↑/↓ to select · Enter to resume · Esc to cancel\x1b[0m\r\n";
  const SHELL = "\x1b[32mdev@workstation\x1b[0m:\x1b[34m~/code/storefront\x1b[0m$ ";

  const handlers = {
    list_orgs: () => [org],
    list_projects: () => [project, other],
    list_groups: () => groups,
    list_tasks: () => tasks,
    list_agents: () => agents,
    list_runs: () => [],
    reconcile_runs: () => 0,
    get_settings: () => ({}),
    list_tmp: () => [],
    tmp_dir: () => null,
    list_plans: () => Object.keys(plans).sort().map(planFile),
    read_plan: ({ name }) => plans[name] ?? "",
    write_plan: ({ name, contents }) => ((plans[name] = contents), planFile(name)),
    create_plan: ({ name }) => ((plans[`${name}.md`] = ""), planFile(`${name}.md`)),
    list_branches: () => ["main", "search-index", "lazy-reviews"],
    list_worktrees: () => [],
    indexed_files: () => 1284,
    mcp_catalog: () => [
      { key: "chrome-devtools", name: "Chrome DevTools", description: "Drive and inspect your own Chrome.", docs: "", server: "chrome-devtools-mcp", installed: true },
      { key: "github", name: "GitHub", description: "Issues, pull requests and code search.", docs: "", server: "github-mcp", installed: false },
    ],
    list_slash_commands: () => [],
    list_plugins: () => [
      { id: "impeccable", name: "impeccable", description: "Design review and polish for frontend work.", version: "1.4.0", installed: true, enabled: true },
    ],
    list_terminals: () => [{ command: "gnome-terminal", name: "GNOME Terminal" }],
    list_editors: () => [{ command: "code", name: "VS Code" }],
    browser_mcp_config: () => null,
    pty_sessions: () => [],
    pty_shared: () => false,
    pty_spawn: ({ options }) => {
      const id = `pty${nextCallback++}`;
      const text = options.command?.includes("--resume") ? RESUME : SHELL;
      setTimeout(() => emit("pty://output", { id, bytes: base64(text) }), 300);
      return id;
    },
    "plugin:event|listen": ({ event, handler }) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return handler;
    },
  };

  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (callback) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => path,
    invoke: async (cmd, args = {}) => {
      const handler = handlers[cmd];
      return handler ? handler(args) : null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
