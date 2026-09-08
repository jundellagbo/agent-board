import {
  isCommandCard,
  pickAgent,
  pickModel,
  priorWork,
  resolveCommand,
  taskPrompt,
} from "./agent";
import { markStep, parseChecklist } from "./checklist";
import { nextClaim, type Column } from "./claim";
import { SENTINEL_INSTRUCTION } from "./outcome";
import { PLAN_INSTRUCTION } from "./plan";
import { REMOTE_COMMAND } from "./remote";
import { stepInstruction } from "./steps";
import { runs as runApi, tasks as taskApi, worktrees as worktreeApi } from "./ipc";
import * as terminals from "./terminals";
import type { Agent, BoardGroup, Project, Task } from "./types";

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
  // fight over one working tree. Non-git projects just run in place.
  const task = (await worktreeApi.ensure(card.id).catch(() => null)) ?? card;
  const agent = pickAgent(agents, { task, group, project });
  const cwd = task.worktreePath ?? project.path;
  // What earlier columns did with this card, so the agent picking it up now is
  // not starting from nothing.
  const history = priorWork(
    await runApi.list(task.id).catch(() => []),
    (groupId) =>
      context.groups.find((column) => column.id === groupId)?.name ?? "an earlier column",
  );

  // A card whose body is a checklist gets its boxes ticked as the agent works,
  // but only if the agent says which step it just finished — nothing else in the
  // output distinguishes a finished step from a mention of one.
  let body = task.body ?? "";
  const steps = parseChecklist(body).length;
  const stepPrompt =
    steps > 0 ? stepInstruction(steps) : group.plans ? stepInstruction() : null;

  const template = group.command || agent?.command || "";
  // Every column's prompt gains the outcome convention, rather than every board
  // having to remember to write it.
  const command = template
    ? resolveCommand(template, {
        task,
        group: {
          ...group,
          prompt: [
            group.prompt,
            group.plans ? PLAN_INSTRUCTION : null,
            stepPrompt,
            SENTINEL_INSTRUCTION,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        path: cwd,
        history,
        model: pickModel(task, group, agent),
      })
    : "";

  const run = await runApi.claim(task.id, command || "$SHELL", cwd, agent?.id);

  // Assigned by the open below; the callbacks that use it only fire afterwards.
  let sessionId = "";

  try {
    sessionId = await terminals.open({
      cwd,
      command: command || undefined,
      env: {
        AGENT_BOARD_TASK: task.title,
        AGENT_BOARD_RUN: run.id,
        // A command card carries none of the board's own instructions: the CLI
        // would read them as the command's arguments.
        AGENT_BOARD_PROMPT: isCommandCard(task)
          ? taskPrompt(task, group, history)
          : [
              taskPrompt(task, group, history),
              group.plans ? PLAN_INSTRUCTION : null,
              stepPrompt,
              SENTINEL_INSTRUCTION,
            ]
              .filter(Boolean)
              .join("\n\n"),
      },
      title: task.title,
      taskId: task.id,
      // Only once the agent has printed a status line of its own: sending a
      // command before then risks answering whatever prompt is on screen.
      onReady: () => {
        if (task.remote) terminals.send(sessionId, REMOTE_COMMAND);
      },
      // The run is still open either way; only the card's label changes, so a
      // failed write here is not worth interrupting the agent over.
      // The card reads Planning only for as long as the agent is writing one,
      // and a card that needs no plan never shows the label at all.
      onPlanning: () => {
        void taskApi
          .update(task.id, { runState: "planning" })
          .then(() => onProgress?.())
          .catch(() => undefined);
      },
      onPlan: (decision) => {
        if (decision.type === "plan") body = decision.body;
        void taskApi
          .update(task.id, {
            runState: "running",
            ...(decision.type === "plan" ? { body: decision.body } : {}),
          })
          .then(() => onProgress?.())
          .catch(() => undefined);
      },
      onStep: (step) => {
        const next = markStep(body, step - 1);
        if (next === body) return;
        body = next;
        void taskApi
          .update(task.id, { body })
          .then(() => onProgress?.())
          .catch(() => undefined);
      },
      onWaiting: (waiting) => {
        onWaiting?.(waiting);
        void taskApi
          .update(task.id, { runState: waiting ? "needs_approval" : "running" })
          .then(() => onProgress?.())
          .catch(() => undefined);
      },
      // The transcript tail becomes the next column's context. It arrives with
      // the exit rather than being looked up, so a command that dies during
      // spawn still reports what it managed to print.
      // The agent stopped working and never said so. Close the run as finished
      // rather than leaving the card claiming to be running forever.
      onIdle: (transcript) => {
        void (async () => {
          await runApi.finish(run.id, 0, "exited", transcript).catch(() => undefined);
          onFinished(0);
        })();
      },
      onExit: async (code, transcript) => {
        await runApi.finish(run.id, code, code === 0 ? "exited" : "error", transcript);
        onFinished(code);
      },
    });
  } catch (cause) {
    // The card is already claimed at this point; close the run out so it does
    // not sit in the running lane forever.
    await runApi.finish(run.id, -1, "error");
    onFinished(-1);
    throw cause;
  }
}
