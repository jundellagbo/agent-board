"use client";

import { PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui";
import { runs as runApi } from "@/lib/ipc";
import type { Task, TaskRun } from "@/lib/types";

/**
 * What a card has been through, for when its terminal is gone — the session
 * ended, or the app was restarted and the pty went with it. Opening a card used
 * to start a fresh agent in that situation, which is a second run on work that
 * may already be done.
 */
export function TaskPreview({
  task,
  onRun,
  onClose,
}: {
  task: Task;
  onRun: () => void;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);

  useEffect(() => {
    let current = true;
    void runApi
      .list(task.id)
      .then((list) => current && setRuns(list))
      .catch(() => current && setRuns([]));
    return () => {
      current = false;
    };
  }, [task.id]);

  const last = runs?.[0];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[calc(var(--radius)*1.5)] border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{task.title}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {task.worktreePath ?? task.branch ?? "no worktree"}
          </p>
        </div>
        <StatusBadge state={task.runState} />
        <Button size="sm" onClick={onRun}>
          <PlayIcon />
          {runs && runs.length > 0 ? "Run again" : "Run agent"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto py-3">
        {runs === null ? (
          <p className="text-sm text-muted-foreground">Reading this card&apos;s history…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent has run on this card yet. Its terminal will appear here once one does.
          </p>
        ) : (
          <div className="space-y-4">
            {last?.summary && (
              <section className="space-y-1">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Last run said
                </h2>
                <pre className="scroll-pane max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                  {last.summary}
                </pre>
              </section>
            )}

            <section className="space-y-1">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Runs
              </h2>
              <ul className="space-y-1">
                {runs.map((run) => (
                  <li key={run.id} className="flex items-baseline gap-2 text-xs">
                    <span
                      className={
                        run.exitCode === 0
                          ? "text-success"
                          : run.status === "running"
                            ? "text-primary"
                            : "text-destructive"
                      }
                    >
                      {run.status}
                    </span>
                    <span className="text-muted-foreground">{run.startedAt.slice(0, 19)}</span>
                    <span className="truncate font-mono text-muted-foreground">{run.command}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
