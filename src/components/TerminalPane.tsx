"use client";

import "@xterm/xterm/css/xterm.css";

import { ColumnsIcon, ExternalLinkIcon, RowsIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "./ui";
import { systemTerminal as systemTerminalApi } from "@/lib/ipc";
import * as terminals from "@/lib/terminals";
import type { Project } from "@/lib/types";

type Direction = "horizontal" | "vertical";

function useSessions() {
  return useSyncExternalStore(terminals.subscribe, terminals.list, terminals.empty);
}

function Surface({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    return terminals.attach(id, container.current);
  }, [id]);

  return <div ref={container} className="h-full w-full" />;
}

export function TerminalPane({
  project,
  activeId,
  onActivate,
  onFinishTask,
}: {
  project: Project;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  /** Closes out the run behind a session whose agent never announced one. */
  onFinishTask: (taskId: string, outcome: "done" | "blocked") => void;
}) {
  const sessions = useSessions();
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("horizontal");
  // Which sessions are on screen right now. Everything else stays alive behind
  // the tab strip, so splitting never costs you a running agent.
  const [visible, setVisible] = useState<string[]>([]);

  const open = visible.filter((id) => sessions.some((session) => session.id === id));
  const focused = open.includes(activeId ?? "") ? activeId : (open[0] ?? null);
  // Only a session started from a card can move a card on.
  const focusedSession = sessions.find((session) => session.id === focused) ?? null;
  const focusedTask = focusedSession?.taskId ?? null;

  useEffect(() => {
    const live = new Set(sessions.map((session) => session.id));

    setVisible((current) => {
      let next = current.filter((id) => live.has(id));

      // A card opened elsewhere activates its own session; adopt it into a pane
      // instead of overriding the caller and losing the terminal they asked for.
      if (activeId && live.has(activeId) && !next.includes(activeId)) {
        next = next.length === 0 ? [activeId] : [activeId, ...next.slice(1)];
      }
      if (next.length === 0 && live.size > 0) next = [sessions[0].id];

      const unchanged =
        next.length === current.length && next.every((id, index) => id === current[index]);
      return unchanged ? current : next;
    });
  }, [sessions, activeId]);

  /**
   * Hands the focused session to a real terminal window. With tmux it attaches
   * to the very session on screen; without it, the best that can be offered is
   * a shell in the same directory, which the message says.
   */
  async function detach() {
    if (!focusedSession) return;
    try {
      const shared = focusedSession.taskId ? terminals.shareName(focusedSession.taskId) : null;
      const opened = await systemTerminalApi.open(
        focusedSession.cwd,
        shared ? `tmux attach -t ${shared} || exec $SHELL` : undefined,
      );
      setError(shared ? null : `Opened ${opened} in ${focusedSession.cwd}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function spawn(mode: "replace" | "split") {
    try {
      const id = await terminals.open({ cwd: project.path, title: project.name });
      setVisible((current) => (mode === "split" ? [...current, id] : [id]));
      onActivate(id);
      setError(null);
      requestAnimationFrame(() => terminals.focus(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function show(id: string) {
    // A tab replaces whichever pane has focus, rather than always the first.
    setVisible((current) => {
      if (current.includes(id)) return current;
      if (current.length === 0) return [id];
      return current.map((paneId) => (paneId === focused ? id : paneId));
    });
    onActivate(id);
    requestAnimationFrame(() => terminals.focus(id));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[calc(var(--radius)*1.5)] border border-border bg-card">
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1.5">
        <div className="scroll-pane flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs ${
                open.includes(session.id)
                  ? "bg-muted"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <button
                type="button"
                onClick={() => show(session.id)}
                className="flex max-w-40 items-center gap-1.5 truncate"
              >
                {session.waiting && (
                  <span
                    aria-label="waiting for you"
                    title="Waiting for you"
                    className="size-1.5 shrink-0 rounded-full bg-warning"
                  />
                )}
                <span className="truncate">{session.title}</span>
                {session.exitCode !== null && (
                  <span
                    className={
                      session.exitCode === 0 ? "text-muted-foreground" : "text-destructive"
                    }
                  >
                    ({session.exitCode})
                  </span>
                )}
              </button>
              {/* A card's terminal belongs to its run: closing it mid-flight
                  would kill the agent and strand the card. Once the run has
                  ended there is nothing to protect, so it can be tidied away. */}
              {(session.taskId === undefined ||
                session.exitCode !== null ||
                session.finished) && (
                <button
                  type="button"
                  aria-label={`Close ${session.title}`}
                  onClick={() => void terminals.close(session.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>

        {focusedTask && (
          <>
            <Button
              size="xs"
              variant="ghost"
              title="Move the card on as if the agent had finished"
              onClick={() => onFinishTask(focusedTask, "done")}
            >
              Finished
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              title="Send the card back — the agent could not finish"
              onClick={() => onFinishTask(focusedTask, "blocked")}
            >
              Blocked
            </Button>
          </>
        )}

        {open.length > 1 && (
          <Button
            size="icon-xs"
            variant="ghost"
            title={direction === "horizontal" ? "Stack the panes" : "Place the panes side by side"}
            onClick={() => setDirection(direction === "horizontal" ? "vertical" : "horizontal")}
          >
            {direction === "horizontal" ? <RowsIcon /> : <ColumnsIcon />}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={open.length === 0}
          title="Open another terminal beside this one"
          onClick={() => void spawn("split")}
        >
          Split
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="Open this session in a real terminal window"
          disabled={!focusedSession}
          onClick={() => void detach()}
        >
          <ExternalLinkIcon />
        </Button>
        <Button size="sm" variant="outline" onClick={() => void spawn("replace")}>
          Open terminal
        </Button>
      </div>

      {error && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 p-1.5">
        {open.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-sm text-muted-foreground">No terminal open.</p>
            <Button size="sm" onClick={() => void spawn("replace")}>
              Open a shell in {project.name}
            </Button>
          </div>
        ) : (
          <div
            className={`flex h-full gap-2 ${direction === "horizontal" ? "flex-row" : "flex-col"}`}
          >
            {sessions.map((session) => {
              const index = open.indexOf(session.id);
              // Every session stays mounted; hiding rather than unmounting is
              // what keeps its scrollback and its running process intact.
              return (
                <div
                  key={session.id}
                  hidden={index === -1}
                  onMouseDown={() => onActivate(session.id)}
                  style={{ order: index }}
                  className={`min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg ${
                    open.length > 1 && session.id === focused
                      ? "ring-1 ring-ring"
                      : "ring-1 ring-transparent"
                  }`}
                >
                  <Surface id={session.id} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
