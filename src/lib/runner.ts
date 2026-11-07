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

  // A card whose body is a checklist gets its boxes ticked as the agent works,
  // but only if the agent says which step it just finished — nothing else in the
  // output distinguishes a finished step from a mention of one.
  //
  // The plan the agent writes is kept apart from that body. The card's text is
  // the person's; a plan written over it loses what they actually asked for.
  let body = task.body ?? "";
  let plan = task.plan ?? "";
  const steps = parseChecklist(body).length;
  const stepPrompt = steps > 0 ? stepInstruction(steps) : group.plans ? stepInstruction() : null;

  // The card's files sit outside the worktree, so an agent confined to its
  // working directory has to be let in to read what the card handed it.
  const scratch = await tmpApi.dir(task.id).catch(() => null);

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
        tmp: scratch,
      })
    : "";

  const run = await runApi.claim(task.id, command || "$SHELL", cwd, agent?.id);

  // Assigned by the open below; the callbacks that use it only fire afterwards.
  let sessionId = "";

  /**
   * Closes the run, once.
   *
   * Three things can end a run — the agent announcing an outcome, the session
   * going quiet, or the process exiting — and for an interactive agent the
   * first of those is the only one that happens promptly: it finishes, says so,
   * and sits at its prompt indefinitely. The announcement was being detected
   * and then dropped on the floor, which is what left cards on Running long
   * after the work was done. Whichever arrives first wins; the later ones would
   * otherwise re-finish the run and route the card a second time.
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
        if (decision.type === "plan") plan = decision.body;
        void taskApi
          .update(task.id, {
            runState: "running",
            ...(decision.type === "plan" ? { plan: decision.body } : {}),
          })
          .then(() => onProgress?.())
          .catch(() => undefined);
      },
      // A step ticks the list it was counted from: the card's own checklist when
      // the person wrote one, otherwise the plan the agent wrote for itself.
      onStep: (step) => {
        const ticking = steps > 0 ? body : plan;
        const next = markStep(ticking, step - 1);
        if (next === ticking) return;

        if (steps > 0) body = next;
        else plan = next;
        void taskApi
          .update(task.id, steps > 0 ? { body: next } : { plan: next })
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
      // The agent said it had finished, or that it could not. This is the
      // normal end of a run: an interactive agent does not exit afterwards.
      onOutcome: (outcome, transcript) =>
        void close(
          outcome === "done" ? 0 : 1,
          outcome === "done" ? "exited" : "blocked",
          transcript,
        ),
      // It stopped working and never said so.
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
