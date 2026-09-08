import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  Agent,
  AgentPatch,
  BoardGroup,
  GroupPatch,
  Organization,
  Project,
  Task,
  TaskPatch,
  TaskRun,
  ResolvedGithub,
  IndexStatus,
  CatalogItem,
  McpScope,
  SlashCommand,
  Plugin,
  Editor,
} from "./types";

// Every Rust error serializes to a string, so surface it as a real Error with
// the command name attached — an unadorned string throw is unreadable in a UI.
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // `next dev` in a plain browser has no Rust side; say so rather than letting
  // an undefined-invoke TypeError stand in for the real explanation.
  if (!isTauri()) {
    throw new Error(`${command}: unavailable outside the Agent Board desktop app`);
  }
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    const message = typeof cause === "string" ? cause : String(cause);
    throw new Error(`${command}: ${message}`, { cause });
  }
}

export const orgs = {
  list: () => call<Organization[]>("list_orgs"),
  create: (name: string) => call<Organization>("create_org", { name }),
  rename: (id: string, name: string) => call<Organization>("rename_org", { id, name }),
  remove: (id: string) => call<void>("delete_org", { id }),
};

export const projects = {
  list: (orgId?: string) => call<Project[]>("list_projects", { orgId: orgId ?? null }),
  create: (orgId: string, path: string, name?: string) =>
    call<Project>("create_project", { orgId, path, name: name ?? null }),
  update: (
    id: string,
    patch: {
      name?: string;
      agentId?: string | null;
      useWorktrees?: boolean;
      autoRun?: boolean;
    },
  ) =>
    call<Project>("update_project", {
      id,
      name: patch.name ?? null,
      agentId: patch.agentId ?? null,
      useWorktrees: patch.useWorktrees ?? null,
      autoRun: patch.autoRun ?? null,
    }),
  remove: (id: string) => call<void>("delete_project", { id }),
};

export const groups = {
  list: (projectId: string) => call<BoardGroup[]>("list_groups", { projectId }),
  create: (projectId: string, patch: GroupPatch) =>
    call<BoardGroup>("create_group", { projectId, patch }),
  update: (id: string, patch: GroupPatch) => call<BoardGroup>("update_group", { id, patch }),
  remove: (id: string, moveTasksTo?: string) =>
    call<void>("delete_group", { id, moveTasksTo: moveTasksTo ?? null }),
  reorder: (ids: string[]) => call<void>("reorder_groups", { ids }),
};

export const tasks = {
  list: (projectId: string) => call<Task[]>("list_tasks", { projectId }),
  create: (projectId: string, patch: TaskPatch, groupId?: string) =>
    call<Task>("create_task", { projectId, groupId: groupId ?? null, patch }),
  update: (id: string, patch: TaskPatch) => call<Task>("update_task", { id, patch }),
  remove: (id: string) => call<void>("delete_task", { id }),
  move: (id: string, groupId: string, position: number) =>
    call<Task>("move_task", { id, groupId, position }),
  reorder: (groupId: string, ids: string[]) => call<void>("reorder_tasks", { groupId, ids }),

  /** Turns a pasted issue or PR link into a title, body and branch. */
  resolveGithub: (input: string) => call<ResolvedGithub>("resolve_github", { input }),
};

export interface SpawnOptions {
  cwd: string;
  command?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** A tmux session name, so a real terminal can attach to this same session. */
  shareAs?: string;
}

export const terminal = {
  spawn: (options: SpawnOptions) => call<string>("pty_spawn", { options }),
  write: (id: string, data: string) => call<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => call<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => call<void>("pty_kill", { id }),
  sessions: () => call<string[]>("pty_sessions"),

  /** Raw pty bytes, base64 so a chunk that splits a codepoint still round-trips. */
  onOutput: (handler: (event: { id: string; bytes: Uint8Array }) => void) =>
    listen<{ id: string; bytes: string }>("pty://output", ({ payload }) =>
      handler({ id: payload.id, bytes: decode(payload.bytes) }),
    ),

  onExit: (handler: (event: { id: string; code: number }) => void) =>
    listen<{ id: string; code: number }>("pty://exit", ({ payload }) => handler(payload)),
};

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const agents = {
  list: () => call<Agent[]>("list_agents"),
  save: (id: string | null, patch: AgentPatch) => call<Agent>("save_agent", { id, patch }),
  remove: (id: string) => call<void>("delete_agent", { id }),
};

export const board = {
  /** Fires whenever a project's cards move, whoever moved them. */
  onChanged: (handler: (projectId: string) => void) =>
    listen<{ projectId: string }>("board://changed", ({ payload }) => handler(payload.projectId)),
};

export const runs = {
  claim: (taskId: string, command: string, cwd: string, agentId?: string | null) =>
    call<TaskRun>("claim_task", { taskId, command, cwd, agentId: agentId ?? null }),
  finish: (
    runId: string,
    exitCode: number,
    status: TaskRun["status"] = "exited",
    summary?: string,
  ) => call<Task>("finish_run", { runId, exitCode, status, summary: summary ?? null }),
  list: (taskId: string) => call<TaskRun[]>("list_runs", { taskId }),
  /** Abandons the open run without routing the card anywhere. */
  cancel: (taskId: string) => call<Task>("cancel_run", { taskId }),
  /** Closes runs whose session this window can no longer see. */
  reconcile: () => call<number>("reconcile_runs"),
};

export const worktrees = {
  /** Returns null when the project is not a repo or has worktrees switched off. */
  ensure: (taskId: string) => call<Task | null>("ensure_worktree", { taskId }),
  remove: (taskId: string) => call<Task>("remove_worktree", { taskId }),
};

export interface SearchHit {
  path: string;
  snippet: string;
}

export const index = {
  build: (projectId: string) => call<void>("index_project", { projectId }),
  remove: (projectId: string) => call<void>("unindex_project", { projectId }),
  files: (projectId: string) => call<number>("indexed_files", { projectId }),
  search: (projectId: string, query: string, limit?: number) =>
    call<SearchHit[]>("search_project", { projectId, query, limit: limit ?? null }),

  onFinished: (
    handler: (status: {
      projectId: string;
      status: IndexStatus;
      files: number;
      message: string | null;
    }) => void,
  ) =>
    listen<{ projectId: string; status: IndexStatus; files: number; message: string | null }>(
      "project://indexed",
      ({ payload }) => handler(payload),
    ),
};

export const settings = {
  all: () => call<Record<string, string>>("get_settings"),
  set: (key: string, value: string) => call<void>("set_setting", { key, value }),
  clear: (key: string) => call<void>("clear_setting", { key }),
};

export const mcp = {
  catalog: (projectId?: string | null) =>
    call<CatalogItem[]>("mcp_catalog", { projectId: projectId ?? null }),
  install: (key: string, scope: McpScope, projectId?: string | null) =>
    call<string>("install_mcp", { key, scope, projectId: scope === "project" ? projectId : null }),
  uninstall: (server: string, scope: McpScope, projectId?: string | null) =>
    call<string>("uninstall_mcp", {
      server,
      scope,
      projectId: scope === "project" ? projectId : null,
    }),
  /** Installs a server the catalog does not list. */
  installCustom: (name: string, command: string, scope: McpScope, projectId?: string | null) =>
    call<string>("install_custom_mcp", {
      name,
      command,
      scope,
      projectId: scope === "project" ? projectId : null,
    }),
};

export interface WebhookResult {
  name: string;
  ok: boolean;
  message: string | null;
}

export const notify = {
  post: (targets: { name: string; url: string }[], text: string) =>
    call<WebhookResult[]>("post_webhooks", { targets, text }),
};

export const slash = {
  list: (projectId?: string | null) =>
    call<SlashCommand[]>("list_slash_commands", { projectId: projectId ?? null }),
};

export const plugins = {
  list: () => call<Plugin[]>("list_plugins"),
  install: (id: string) => call<string>("install_plugin", { id }),
  uninstall: (id: string) => call<string>("uninstall_plugin", { id }),
};

export const systemTerminal = {
  list: () => call<Editor[]>("list_terminals"),
  open: (cwd: string, run?: string) =>
    call<string>("open_system_terminal", { cwd, run: run ?? null }),
};

export const editors = {
  list: () => call<Editor[]>("list_editors"),
  open: (path: string, command?: string) =>
    call<string>("open_in_editor", { path, command: command ?? null }),
};
