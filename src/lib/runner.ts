import { pickAgent, pickModel, priorWork, resolveCommand, taskPrompt } from "./agent";
import { nextClaim, type Column } from "./claim";
import { REMOTE_COMMAND } from "./remote";
import { runs as runApi, tasks as taskApi, tmp as tmpApi, worktrees as worktreeApi } from "./ipc";
import * as terminals from "./terminals";
import type { Agent, BoardGroup, Project, Task, TaskRun } from "./types";

export { nextClaim };
export type { Column };

export async function start(
  card: Task,
  group: BoardGroup,
  context: { project: Project; agents: Agent[]; groups: BoardGroup[] },
  onFinished: (exitCode: number) => void,
  onProgress?: () => void,
  onWaiting?: (waiting: boolean) => void,
): Promise<void> {
  const { project, agents } = context;

  // Claimed but not yet running. Creating a worktree and starting the agent can
  // take a moment, and a card that just sits there looks stuck otherwise.
  await taskApi.update(card.id, { runState: "queued" }).catch(() => null);
  onProgress?.();

  // A card gets its own checkout before the agent starts, so parallel runs never
  // fight over one working tree. Nothing comes back for a card that wants no
  // worktree, or a project that is not a repo; those do run in place.
  let task = card;
  try {
    task = (await worktreeApi.ensure(card.id)) ?? card;
  } catch (cause) {
    // A card that asked for a checkout of its own must not quietly fall back to
    // the project directory — that is the tree every other agent is editing.
    await taskApi.update(card.id, { runState: "blocked" }).catch(() => null);
    onProgress?.();
    throw cause;
  }
  const agent = pickAgent(agents, { task, group, project });
  const cwd = task.worktreePath ?? project.path;
  // What earlier columns did with this card, so the agent picking it up now is
  // not starting from nothing.
  const history = priorWork(
    await runApi.list(task.id).catch(() => []),
    (groupId) =>
      context.groups.find((column) => column.id === groupId)?.name ?? "an earlier column",
  );

  // The card's files sit outside the worktree, so an agent confined to its
  // working directory has to be let in to read what the card handed it.
  const scratch = await tmpApi.dir(task.id).catch(() => null);

  const template = group.command || agent?.command || "";
  // Only the card and the column's own prompt go to the agent: done is read from
  // the session going idle, so no board protocol is spent on every run's tokens.
  const command = template
    ? resolveCommand(template, {
        task,
        group,
        path: cwd,
        history,
        model: pickModel(task, group, agent),
        tmp: scratch,
      })
    : "";

  const run = await runApi.claim(task.id, command || "$SHELL", cwd, agent?.id);

  // Assigned by the open below; the callbacks that use it only fire afterwards.
  let sessionId = "";

  /**
   * Closes the run, once.
   *
   * Either the session going quiet or the process exiting can end a run;
   * whichever arrives first wins, since the later one would otherwise
   * re-finish the run and route the card a second time.
   */
  let closed = false;
  const close = async (
    exitCode: number,
    status: TaskRun["status"],
    transcript?: string,
  ): Promise<void> => {
    if (closed) return;
    closed = true;
    await runApi.finish(run.id, exitCode, status, transcript).catch(() => undefined);
    onFinished(exitCode);
  };

  try {
    sessionId = await terminals.open({
      cwd,
      command: command || undefined,
      env: {
        AGENT_BOARD_TASK: task.title,
        AGENT_BOARD_RUN: run.id,
        AGENT_BOARD_PROMPT: taskPrompt(task, group, history),
      },
      title: task.title,
      taskId: task.id,
      // Only once the agent has printed a status line of its own: sending a
      // command before then risks answering whatever prompt is on screen.
      onReady: () => {
        if (task.remote) terminals.send(sessionId, REMOTE_COMMAND);
      },
      onWaiting: (waiting) => {
        onWaiting?.(waiting);
        void taskApi
          .update(task.id, { runState: waiting ? "needs_approval" : "running" })
          .then(() => onProgress?.())
          .catch(() => undefined);
      },
      // An interactive agent does not exit when it finishes; it goes quiet at
      // its own prompt, and that is the normal end of a run.
      onIdle: (transcript) => void close(0, "exited", transcript),
      // The transcript tail becomes the next column's context. It arrives with
      // the exit rather than being looked up, so a command that dies during
      // spawn still reports what it managed to print.
      onExit: (code, transcript) => void close(code, code === 0 ? "exited" : "error", transcript),
    });
  } catch (cause) {
    // The card is already claimed at this point; close the run out so it does
    // not sit in the running lane forever.
    await close(-1, "error");
    throw cause;
  }
}
