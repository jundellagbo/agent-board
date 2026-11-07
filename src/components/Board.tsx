"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { AttachmentPreview } from "./Attachments";
import { Column, columnDragId, groupIdFromDrag } from "./Column";
import { Button, CheckField, Modal } from "./ui";
import { GroupDialog } from "./GroupDialog";
import { TaskCardBody, type CardAction } from "./TaskCard";
import { TaskDialog } from "./TaskDialog";
import { useAttachments } from "@/lib/attachments";
import { useBoard } from "@/lib/board";
import { parseChecklist, toggleStep } from "@/lib/checklist";
import { withFollowUp } from "@/lib/followup";
import { nextClaim } from "@/lib/claim";
import { announceApproval, announceCompletion } from "@/lib/notify";
import { REMOTE_COMMAND } from "@/lib/remote";
import { start } from "@/lib/runner";
import { editors as editorApi, projects as projectApi, runs as runApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import * as terminals from "@/lib/terminals";
import type { BoardGroup, Editor, Project, Task, TmpFile } from "@/lib/types";

export function Board({
  project,
  onOpenTask,
  refreshToken = 0,
}: {
  project: Project;
  onOpenTask: (task: Task, group: BoardGroup, groups: BoardGroup[]) => void;
  /** Changes when something outside the board moved a card. */
  refreshToken?: number;
}) {
  const {
    columns,
    groups,
    loading,
    error,
    refresh,
    moveTask,
    addTask,
    updateTask,
    removeTask,
    addGroup,
    updateGroup,
    removeGroup,
    reorderGroups,
  } = useBoard(project.id);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // One claim in flight at a time; the effect re-runs on every board change,
  // and a second pass must not start the same card twice.
  const claiming = useRef(false);
  const [editing, setEditing] = useState<BoardGroup | "new" | null>(null);
  // Removing a card also removes its worktree, so it is asked about rather than
  // done from a menu click.
  const [removing, setRemoving] = useState<Task | null>(null);
  const [editingCard, setEditingCard] = useState<Task | null>(null);
  const [previewing, setPreviewing] = useState<TmpFile | null>(null);
  const [planFor, setPlanFor] = useState<Task | null>(null);
  // Whatever this machine has; the menu says its name rather than "an editor".
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    void editorApi
      .list()
      .then((found) => setEditor(found[0] ?? null))
      .catch(() => setEditor(null));
  }, []);
  const { agents, notifications, run } = useStore();
  // The whole store in one call, rather than a listener and a read per card.
  const { files: tmpFiles, remove: removeFile, reveal: revealFile } = useAttachments();
  const filesByCard = useMemo(() => {
    const byCard: Record<string, TmpFile[]> = {};
    for (const file of tmpFiles) (byCard[file.cardId] ??= []).push(file);
    return byCard;
  }, [tmpFiles]);
  // One subscription for the whole board rather than one per card.
  const sessions = useSyncExternalStore(terminals.subscribe, terminals.list, terminals.empty);
  const statuses = Object.fromEntries(
    sessions.flatMap((session) =>
      session.taskId && session.status ? [[session.taskId, session.status]] : [],
    ),
  );
  const autoRun = project.autoRun;

  const sensors = useSensors(
    // A few pixels of slop keeps a click on a card from registering as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (refreshToken > 0) void refresh();
  }, [refreshToken, refresh]);

  useEffect(() => {
    if (!autoRun || claiming.current) return;
    const claim = nextClaim(columns, (taskId) => Boolean(terminals.find(taskId)), autoRun);
    if (!claim) return;

    claiming.current = true;
    void start(
      claim.task,
      claim.group,
      { project, agents, groups },
      (exitCode) => {
        void announceCompletion(notifications, claim.task, project.name, exitCode);
        void refresh();
      },
      refresh,
      (waiting) => {
        if (waiting) void announceApproval(notifications, claim.task, project.name);
      },
    )
      .catch(() => undefined)
      .finally(() => {
        claiming.current = false;
        void refresh();
      });
  }, [autoRun, columns, groups, project, agents, notifications, refresh]);

  /**
   * What you can do to a card without going and finding its terminal.
   * Interrupt and continue talk to the agent; block and drop close the run —
   * block says a person is needed and routes accordingly, drop just abandons
   * the attempt and leaves the card where it is.
   */
  async function control(task: Task, action: CardAction) {
    const session = terminals.find(task.id);

    if (action === "edit") {
      setEditingCard(task);
      return;
    }

    if (action === "plan") {
      setPlanFor(task);
      return;
    }

    if (action === "open") {
      // The project root, not the card's worktree: an editor window is where
      // you read the whole codebase, and a worktree is a partial view of it.
      try {
        await editorApi.open(project.path, editor?.command);
      } catch (cause) {
        setOpenError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }

    if (action === "files") {
      // The store lives outside the project, so the file manager is the only
      // place to actually work with what is in it.
      const [file] = filesByCard[task.id] ?? [];
      if (file) void revealFile(file.path);
      return;
    }

    if (action === "remove") {
      setRemoving(task);
      return;
    }

    if (action === "remote") {
      const remote = !task.remote;
      await updateTask(task.id, { remote });
      // Turning it on mid-run takes effect now rather than at the next start.
      if (remote && session) terminals.send(session.id, REMOTE_COMMAND);
      return;
    }

    if (action === "interrupt" || action === "continue") {
      if (!session) return;
      if (action === "interrupt") terminals.interrupt(session.id);
      else terminals.send(session.id, "continue");
      return;
    }

    const transcript = session ? terminals.transcript(session.id) : "";
    if (session) await terminals.close(session.id).catch(() => undefined);

    const [run] = await runApi.list(task.id).catch(() => []);
    if (action === "drop") {
      await runApi.cancel(task.id).catch(() => undefined);
    } else if (run && run.finishedAt === null) {
      await runApi.finish(run.id, 1, "blocked", transcript).catch(() => undefined);
    } else {
      await updateTask(task.id, { runState: "blocked" });
    }
    await refresh();
  }

  /** Stops the agent, closes the run, then deletes the card. */
  async function remove(task: Task) {
    const session = terminals.find(task.id);
    if (session) await terminals.close(session.id).catch(() => undefined);
    await runApi.cancel(task.id).catch(() => undefined);
    await removeTask(task.id);
  }

  function findTask(id: string): Task | undefined {
    return columns.flatMap((column) => column.tasks).find((task) => task.id === id);
  }

  function onDragStart(event: DragStartEvent) {
    setDragging(findTask(String(event.active.id)) ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;

    // Columns and cards share one drag context, told apart by the id shape.
    const movedColumn = groupIdFromDrag(String(active.id));
    if (movedColumn) {
      const target = groupIdFromDrag(String(over.id));
      if (!target || target === movedColumn) return;

      const order = groups.map((group) => group.id);
      const from = order.indexOf(movedColumn);
      const to = order.indexOf(target);
      if (from === -1 || to === -1) return;

      order.splice(to, 0, ...order.splice(from, 1));
      void reorderGroups(order);
      return;
    }

    const task = findTask(String(active.id));
    if (!task) return;

    // `over` is either a column (dropped on empty space) or another card, whose
    // slot the dragged card takes over.
    const overId = String(over.id);
    const overColumn = columns.find((column) => column.group.id === overId);
    const target = overColumn
      ? { groupId: overColumn.group.id, position: overColumn.tasks.length }
      : (() => {
          const overTask = findTask(overId);
          if (!overTask) return null;
          const column = columns.find((c) => c.group.id === overTask.groupId);
          const index = column?.tasks.findIndex((t) => t.id === overTask.id) ?? 0;
          return { groupId: overTask.groupId, position: index };
        })();

    if (!target) return;
    if (task.groupId === target.groupId && task.position === target.position) return;
    moveTask(task.id, target.groupId, target.position);
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading board…</p>;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <CheckField
          label="Run cards automatically"
          checked={autoRun}
          hint={autoRun ? undefined : "paused for this project"}
          onChange={(checked) =>
            void run(() => projectApi.update(project.id, { autoRun: checked }))
          }
        />
        {(error ?? openError) && (
          <p role="alert" className="text-xs text-destructive">
            {error ?? openError}
          </p>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="scroll-pane flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto pb-1">
          <SortableContext
            items={columns.map((column) => columnDragId(column.group.id))}
            strategy={horizontalListSortingStrategy}
          >
            {columns.map((column) => (
              <Column
                key={column.group.id}
                column={column}
                onAdd={addTask}
                onOpen={(task, column) => onOpenTask(task, column, groups)}
                onEdit={setEditing}
                onToggleStep={(task, index) =>
                  void updateTask(task.id, { body: toggleStep(task.body, index) })
                }
                onAction={(task, action) => void control(task, action)}
                statuses={statuses}
                files={filesByCard}
                onOpenFile={setPreviewing}
                onRemoveFile={(file) => void removeFile(file.path)}
                editor={editor?.name}
              />
            ))}
          </SortableContext>

          <button
            type="button"
            onClick={() => setEditing("new")}
            className="h-fit w-44 shrink-0 rounded-[calc(var(--radius)*1.5)] border border-dashed border-border px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            + Add column
          </button>
        </div>

        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="w-72">
              <TaskCardBody task={dragging} dragging />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {previewing && (
        <AttachmentPreview
          file={previewing}
          onClose={() => setPreviewing(null)}
          onRemove={() => void removeFile(previewing.path)}
          onReveal={() => void revealFile(previewing.path)}
        />
      )}

      {planFor && <PlanDialog task={planFor} onClose={() => setPlanFor(null)} />}

      {editingCard && (
        <TaskDialog
          task={editingCard}
          running={Boolean(terminals.find(editingCard.id))}
          onClose={() => setEditingCard(null)}
          onSave={({ title, body, followUp }) => {
            const session = terminals.find(editingCard.id);
            // A running agent is told; a card that is not running keeps the
            // follow-up for whoever picks it up.
            if (followUp.trim() && session) terminals.send(session.id, followUp.trim());
            void updateTask(editingCard.id, {
              title,
              body: session ? body : withFollowUp(body, followUp),
            });
          }}
        />
      )}

      {removing && (
        <Modal title={`Remove “${removing.title}”?`} onClose={() => setRemoving(null)}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {terminals.find(removing.id)
                ? "Its agent is running and will be stopped first."
                : "The card and its run history go with it."}
              {removing.worktreePath &&
                " Its git worktree is removed too, along with anything uncommitted in it."}
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRemoving(null)}>
                Keep it
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  const card = removing;
                  setRemoving(null);
                  void remove(card);
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <GroupDialog
          group={editing === "new" ? undefined : editing}
          groups={groups}
          agents={agents}
          onSave={(patch) =>
            editing === "new" ? void addGroup(patch) : void updateGroup(editing.id, patch)
          }
          onDelete={
            editing === "new"
              ? undefined
              : (moveTasksTo) => void removeGroup(editing.id, moveTasksTo)
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * What the agent said it would do, for a card whose plan is buried in a
 * terminal somewhere. A card that was never planned says so rather than
 * showing an empty box.
 */
function PlanDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const steps = parseChecklist(task.plan);

  return (
    <Modal title={`Plan — ${task.title}`} onClose={onClose} width="sm:max-w-lg">
      {steps.length > 0 ? (
        <ol className="space-y-1.5 text-sm">
          {steps.map((step, index) => (
            <li key={`${index}-${step.text}`} className="flex items-start gap-2">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {index + 1}.
              </span>
              <span className={step.done ? "text-muted-foreground line-through" : ""}>
                {step.text}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">
          {task.plan?.trim() || "No plan yet — the agent has not written one for this card."}
        </p>
      )}
    </Modal>
  );
}
