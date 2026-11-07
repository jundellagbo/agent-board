"use client";

import { useCallback, useState } from "react";

import { Board } from "./Board";
import { Header } from "./Header";
import { SettingsPane } from "./SettingsPane";
import { Sidebar } from "./Sidebar";
import { TaskPreview } from "./TaskPreview";
import { TerminalPane } from "./TerminalPane";
import { pickAgent, pickModel, priorWork, resolveCommand, taskPrompt } from "@/lib/agent";
import {
  runs as runApi,
  tasks as taskApi,
  tmp as tmpApi,
  worktrees as worktreeApi,
} from "@/lib/ipc";
import { announceApproval } from "@/lib/notify";
import { useStore } from "@/lib/store";
import * as terminals from "@/lib/terminals";
import type { BoardGroup, Task } from "@/lib/types";

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

export function AppShell() {
  const { view, project, agents, notifications, loading, error, setView } = useStore();
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // The board owns its own data; this tells it something changed underneath.
  const [boardVersion, setBoardVersion] = useState(0);
  const [preview, setPreview] = useState<{
    task: Task;
    group: BoardGroup;
    groups: BoardGroup[];
  } | null>(null);

  // The runner closes a run when the agent announces an outcome; this is for
  // the agent that never does, so a card is never stranded on Running.
  const finishTask = useCallback(async (taskId: string, outcome: "done" | "blocked") => {
    const [run] = await runApi.list(taskId).catch(() => []);
    const session = terminals.find(taskId);
    const code = outcome === "done" ? 0 : 1;
    try {
      if (run && run.finishedAt === null) {
        // finish_run also routes the card by that code.
        await runApi.finish(run.id, code, "exited", terminals.transcript(session?.id ?? ""));
      } else {
        await taskApi.update(taskId, { runState: outcome === "done" ? "done" : "failed" });
      }
      setBoardVersion((version) => version + 1);
      setSessionError(null);
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** Starts an agent on a card. Only ever from an explicit Run. */
  const runTask = useCallback(
    async (card: Task, group: BoardGroup, groups: BoardGroup[]) => {
      if (!project) return;

      // Opening a card by hand tells the agent as much as the runner would.
      const history = priorWork(
        await runApi.list(card.id).catch(() => []),
        (groupId) => groups.find((column) => column.id === groupId)?.name ?? "an earlier column",
      );
      try {
        // Its own checkout, the same as an automatic run gets — a card started
        // by hand used to run in the project directory until some other run had
        // made it one.
        const task = (await worktreeApi.ensure(card.id)) ?? card;
        const cwd = task.worktreePath ?? project.path;
        // The card's files sit outside the worktree, so an agent confined to its
        // working directory has to be let in to read them.
        const scratch = await tmpApi.dir(task.id).catch(() => null);
        // A column's own command wins over the agent's: that is the point of
        // giving a column like "Testing" its own skill and command.
        const agent = pickAgent(agents, { task, group, project });
        const template = group.command || agent?.command;

        const id = await terminals.open({
          cwd,
          command: template
            ? resolveCommand(template, {
                task,
                group,
                path: cwd,
                history,
                model: pickModel(task, group, agent),
                tmp: scratch,
              })
            : undefined,
          env: {
            AGENT_BOARD_TASK: task.title,
            AGENT_BOARD_PROMPT: taskPrompt(task, group, history),
          },
          title: task.title,
          taskId: task.id,
          // A card started by hand ends the same way as one the runner started:
          // on the agent's own announcement. Without this it sat on Running
          // until someone pressed Finished by hand.
          onOutcome: (outcome) => void finishTask(task.id, outcome),
          onIdle: () => void finishTask(task.id, "done"),
          onWaiting: (waiting) => {
            if (waiting) void announceApproval(notifications, task, project.name);
            void taskApi
              .update(task.id, { runState: waiting ? "needs_approval" : "running" })
              .catch(() => undefined);
          },
        });
        setActiveSession(id);
        setPreview(null);
        setSessionError(null);
      } catch (cause) {
        setSessionError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [project, agents, notifications, finishTask],
  );

  /**
   * Rejoins the agent already in the card's tmux session, and tells it what to
   * do next. Nothing is re-run: the session is still there with everything it
   * has read and written, which a fresh run would start over without.
   */
  const continueTask = useCallback(
    async (task: Task, next: string) => {
      if (!project) return;
      try {
        const id = await terminals.open({
          // No command: `tmux new-session -A` rejoins the session that is
          // already there rather than starting a second agent in it.
          cwd: task.worktreePath ?? project.path,
          title: task.title,
          taskId: task.id,
          onOutcome: (outcome) => void finishTask(task.id, outcome),
          onIdle: () => void finishTask(task.id, "done"),
          onWaiting: (waiting) => {
            if (waiting) void announceApproval(notifications, task, project.name);
            void taskApi
              .update(task.id, { runState: waiting ? "needs_approval" : "running" })
              .catch(() => undefined);
          },
        });
        // Straight after the attach: the tty buffers input the agent has not
        // read yet, so there is no prompt to wait for.
        if (next.trim()) terminals.send(id, next.trim());
        await taskApi.update(task.id, { runState: "running" }).catch(() => undefined);
        setActiveSession(id);
        setPreview(null);
        setBoardVersion((version) => version + 1);
        setSessionError(null);
      } catch (cause) {
        setSessionError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [project, notifications, finishTask],
  );

  /**
   * Opening a card shows the card: its live terminal if it has one, otherwise
   * what its last run left behind. It never starts an agent — a click on a card
   * that had finished used to launch a second run on the same work.
   */
  const openTask = useCallback(
    (task: Task, group: BoardGroup, groups: BoardGroup[]) => {
      setView("terminal");

      const existing = terminals.find(task.id);
      if (existing) {
        setActiveSession(existing.id);
        setPreview(null);
        return;
      }
      setPreview({ task, group, groups });
    },
    [setView],
  );

  return (
    <div className="flex h-screen w-screen">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header />

        {(error ?? sessionError) && (
          <p
            role="alert"
            className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive"
          >
            {error ?? sessionError}
          </p>
        )}

        <main className="min-h-0 flex-1 overflow-hidden p-4">
          {loading ? (
            <Placeholder title="Loading" hint="Reading the local database." />
          ) : !project ? (
            <Placeholder
              title="No project selected"
              hint="Add an organization and a project directory to start a board."
            />
          ) : view === "board" ? (
            <Board project={project} refreshToken={boardVersion} onOpenTask={openTask} />
          ) : view === "terminal" && preview ? (
            <TaskPreview
              task={preview.task}
              onRun={() => void runTask(preview.task, preview.group, preview.groups)}
              onContinue={(next) => void continueTask(preview.task, next)}
              onClose={() => setPreview(null)}
            />
          ) : view === "terminal" ? (
            <TerminalPane
              project={project}
              activeId={activeSession}
              onActivate={setActiveSession}
              onFinishTask={(taskId, outcome) => void finishTask(taskId, outcome)}
            />
          ) : (
            <SettingsPane />
          )}
        </main>
      </div>
    </div>
  );
}
