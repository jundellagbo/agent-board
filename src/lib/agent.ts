import { commandName } from "./compose.ts";
import type { Agent, BoardGroup, Project, Task, TaskRun } from "./types";

/** What the agent is told to do: the column's standing instruction, then the
 * card, then whatever earlier columns already did with it. */
/**
 * A card whose text begins with a slash command *is* that command.
 *
 * The distinction matters because an agent CLI reads everything after the
 * command name as its arguments. Putting the column's standing instruction in
 * front would stop it being a command at all, and putting anything after it
 * would arrive as arguments the command never asked for.
 */
export function isCommandCard(task: Task): boolean {
  return commandName(task.title) !== null;
}

export function taskPrompt(task: Task, group: BoardGroup, history = ""): string {
  if (isCommandCard(task)) {
    // The command drives itself; everything the board would normally add is
    // left out rather than fed to it as arguments.
    return [task.title.trim(), task.body].filter(Boolean).join("\n");
  }
  return [group.prompt, task.title, task.body, history].filter(Boolean).join("\n\n");
}

// The Rust side splits the command with shell rules, so anything interpolated
// has to survive that split — a card title with a quote in it must not become
// two arguments, or worse, a second command.
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const PLACEHOLDERS = /\{(prompt|task|body|skills|path|model|tmp)\}/g;

// `claude --model {model}` with no model set must not become `claude --model ''`,
// which every CLI reads as a model literally named empty. Drop the flag with it.
const EMPTY_FLAG = /\s*(?:--?[\w-]+[ =])?\{(prompt|task|body|skills|path|model|tmp)\}/g;

export function resolveCommand(
  template: string,
  context: {
    task: Task;
    group: BoardGroup;
    path: string;
    history?: string;
    model?: string | null;
    /** The card's scratch store, when it has one. */
    tmp?: string | null;
  },
): string {
  const values: Record<string, string> = {
    prompt: taskPrompt(context.task, context.group, context.history),
    task: context.task.title,
    body: context.task.body ?? "",
    skills: context.group.skills.join(","),
    path: context.path,
    model: context.model?.trim() ?? "",
    tmp: context.tmp?.trim() ?? "",
  };

  const withoutEmpty = template.replace(EMPTY_FLAG, (match, key: string) =>
    values[key] === "" ? "" : match,
  );
  return withoutEmpty.replace(PLACEHOLDERS, (_, key: string) => quote(values[key] ?? "")).trim();
}

/** Most specific wins, the same order as the agent: card, column, agent. */
export function pickModel(
  task: Task | undefined,
  group: BoardGroup | undefined,
  agent: Agent | undefined,
): string | undefined {
  return task?.model ?? group?.model ?? agent?.model ?? undefined;
}

// Most specific wins: the card, then its column, then the project, then the
// agent marked default.
export function pickAgent(
  agents: Agent[],
  context: { task?: Task; group?: BoardGroup; project?: Project },
): Agent | undefined {
  const byId = (id: string | null | undefined) =>
    id ? agents.find((agent) => agent.id === id) : undefined;

  return (
    byId(context.task?.agentId) ??
    byId(context.group?.agentId) ??
    byId(context.project?.agentId) ??
    agents.find((agent) => agent.isDefault) ??
    agents[0]
  );
}

/**
 * What earlier columns already did with this card. Without it, an agent picking
 * a card up in "Review" starts from nothing and redoes the work the "Todo"
 * agent just finished.
 */
export function priorWork(
  runs: TaskRun[],
  columnName: (groupId: string | null) => string,
  options: { limit?: number; excerpt?: number } = {},
): string {
  const { limit = 3, excerpt = 700 } = options;
  const finished = runs
    .filter((run) => run.finishedAt !== null)
    .slice(0, limit)
    .reverse();
  if (finished.length === 0) return "";

  const entries = finished.map((run) => {
    const outcome =
      run.exitCode === 0 ? "finished cleanly" : `stopped with exit code ${run.exitCode ?? "?"}`;
    const head = `In "${columnName(run.groupId)}" an agent ran \`${run.command}\` and ${outcome}.`;
    const tail = run.summary?.trim();
    if (!tail) return head;

    const excerptText = tail.length > excerpt ? `…${tail.slice(-excerpt)}` : tail;
    return `${head}\nIts last output was:\n${excerptText}`;
  });

  return `Earlier work on this card:\n\n${entries.join("\n\n")}`;
}
