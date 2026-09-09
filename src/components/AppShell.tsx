"use client";

import { useCallback, useState } from "react";

import { Board } from "./Board";
import { Header } from "./Header";
import { SettingsPane } from "./SettingsPane";
import { Sidebar } from "./Sidebar";
import { TaskPreview } from "./TaskPreview";
import { TerminalPane } from "./TerminalPane";
import { pickAgent, pickModel, priorWork, resolveCommand, taskPrompt } from "@/lib/agent";
import { runs as runApi, tasks as taskApi } from "@/lib/ipc";
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
    async (task: Task, group: BoardGroup, groups: BoardGroup[]) => {
      if (!project) return;

      const cwd = task.worktreePath ?? project.path;
      // A column's own command wins over the agent's: that is the point of
      // giving a column like "Testing" its own skill and command.
      const agent = pickAgent(agents, { task, group, project });
      const template = group.command || agent?.command;
      // Opening a card by hand tells the agent as much as the runner would.
      const history = priorWork(
        await runApi.list(task.id).catch(() => []),
        (groupId) => groups.find((column) => column.id === groupId)?.name ?? "an earlier column",
      );
      try {
        const id = await terminals.open({
          cwd,
          command: template
            ? resolveCommand(template, {
                task,
                group,
                path: cwd,
                history,
                model: pickModel(task, group, agent),
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
            <Board
              project={project}
              refreshToken={boardVersion}
              onOpenTask={openTask}
            />
          ) : view === "terminal" && preview ? (
            <TaskPreview
              task={preview.task}
              onRun={() => void runTask(preview.task, preview.group, preview.groups)}
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
