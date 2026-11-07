// Mirrors the serde shapes in src-tauri/src/models.rs (camelCase over the wire).

export interface Organization {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export type IndexStatus = "none" | "indexing" | "indexed" | "error";

export interface Project {
  id: string;
  orgId: string;
  name: string;
  path: string;
  agentId: string | null;
  isGit: boolean;
  useWorktrees: boolean;
  /** Master switch for the runner; a column still needs its own autoRun. */
  autoRun: boolean;
  indexStatus: IndexStatus;
  indexedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export type BoardType = "todo" | "in_progress" | "review" | "done" | "custom";

export interface BoardGroup {
  id: string;
  projectId: string;
  name: string;
  boardType: BoardType;
  position: number;
  autoRun: boolean;
  /** Cards here get a plan before any work starts. */
  plans: boolean;
  skills: string[];
  command: string | null;
  prompt: string | null;
  agentId: string | null;
  /** Overrides the agent's model for cards in this column. */
  model: string | null;
  /** Where a card sits while its agent runs, and where it lands after. */
  runningGroupId: string | null;
  successGroupId: string | null;
  failureGroupId: string | null;
  wipLimit: number | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunState =
  | "idle"
  | "queued"
  | "planning"
  | "running"
  | "needs_approval"
  /** The agent stopped and said it could not finish — a person has to look. */
  | "blocked"
  | "done"
  | "failed";

export interface Task {
  id: string;
  projectId: string;
  groupId: string;
  title: string;
  body: string | null;
  /** What the agent said it would do — never written over the card's own text. */
  plan: string | null;
  position: number;
  agentId: string | null;
  /** Overrides the agent's own model for this card only. */
  model: string | null;
  /** Open this card's session to remote control. */
  remote: boolean;
  /** Give this card a checkout of its own, rather than the project directory. */
  useWorktree: boolean;
  githubUrl: string | null;
  githubKind: "issue" | "pull" | null;
  githubNumber: number | null;
  branch: string | null;
  worktreePath: string | null;
  runState: RunState;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a card was given, and what its agent handed back. */
export type TmpKind = "attached" | "response";

export interface TmpFile {
  cardId: string;
  kind: TmpKind;
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  mime: string;
}

export type GroupPatch = Partial<
  Pick<
    BoardGroup,
    | "name"
    | "boardType"
    | "autoRun"
    | "plans"
    | "skills"
    | "command"
    | "prompt"
    | "agentId"
    | "model"
    | "runningGroupId"
    | "successGroupId"
    | "failureGroupId"
    | "wipLimit"
    | "color"
  >
>;

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "body"
    | "plan"
    | "agentId"
    | "model"
    | "remote"
    | "useWorktree"
    | "githubUrl"
    | "githubKind"
    | "githubNumber"
    | "branch"
    | "runState"
  >
>;

export interface GithubReference {
  url: string;
  owner: string;
  repo: string;
  kind: "issue" | "pull";
  number: number;
}

export interface ResolvedGithub {
  reference: GithubReference | null;
  title: string | null;
  body: string | null;
  /** For a pull request: the branch to check out rather than create. */
  branch: string | null;
}

export interface Agent {
  id: string;
  name: string;
  /** Command template. Placeholders: {prompt} {task} {body} {skills} {path} {model}. */
  command: string;
  env: string;
  /** The model this agent runs, substituted into {model}. */
  model: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentPatch = Partial<Pick<Agent, "name" | "command" | "env" | "model" | "isDefault">>;

export interface TaskRun {
  id: string;
  taskId: string;
  agentId: string | null;
  groupId: string | null;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "error" | "blocked";
  exitCode: number | null;
  logPath: string | null;
  /** The tail of what the agent printed, kept for the next column's prompt. */
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CatalogItem {
  /** Empty for a server that is installed but not one the app ships. */
  key: string;
  name: string;
  description: string;
  docs: string;
  server: string;
  installed: boolean;
}

export type McpScope = "user" | "project";

export interface SlashCommand {
  /** What you type: `/infra-llm-plan`, or `/dir:name` for a nested one. */
  name: string;
  scope: "user" | "project";
  description: string | null;
  argumentHint: string | null;
}

export interface Plugin {
  /** `name@marketplace`, which is what install and uninstall take. */
  id: string;
  name: string;
  description: string;
  version: string | null;
  installed: boolean;
  enabled: boolean;
}

export interface Editor {
  /** The executable, which is also how an editor is asked for by name. */
  command: string;
  name: string;
}
